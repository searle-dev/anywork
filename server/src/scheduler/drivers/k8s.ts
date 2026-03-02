/**
 * Kubernetes container driver.
 *
 * Scheduling model: per-session Pod.
 *   - Each session gets a dedicated K8s Pod + ClusterIP Service.
 *   - Skills and MCP are injected via the /prepare endpoint before each task,
 *     NOT via Pod env vars or init containers.
 *   - Workspace is an emptyDir by default (ephemeral per session).
 *     Set K8S_WORKSPACE_STORAGE=pvc for persistent workspaces.
 *
 * Requirements:
 *   - Server runs inside the cluster (in-cluster SA) or has ~/.kube/config.
 *   - RBAC: server SA needs create/get/delete on pods, services, PVCs
 *     in the target namespace (see deploy/k8s/rbac.yaml).
 */

import * as k8s from "@kubernetes/client-node";
import { ContainerDriver, WorkerEndpoint } from "./interface";

export interface K8sDriverOptions {
  namespace: string;
  workerImage: string;
  workerPort?: number;
  /** Env vars to pass to every worker pod */
  workerEnv?: Record<string, string>;
  /** "emptydir" (default) or "pvc" */
  workspaceStorage?: "emptydir" | "pvc";
  pvcStorageClass?: string;
  resources?: {
    cpuRequest?: string;
    cpuLimit?: string;
    memoryRequest?: string;
    memoryLimit?: string;
  };
  /** Pod idle TTL in seconds before cleanup (0 = no auto-cleanup) */
  idleTtlSeconds?: number;
}

interface CacheEntry {
  endpoint: WorkerEndpoint;
  lastUsedAt: number;
}

export class K8sDriver implements ContainerDriver {
  private readonly k8sCore: k8s.CoreV1Api;
  private readonly opts: Required<K8sDriverOptions>;
  private readonly cache = new Map<string, CacheEntry>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(opts: K8sDriverOptions) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.k8sCore = kc.makeApiClient(k8s.CoreV1Api);

    this.opts = {
      workerPort: 8080,
      workerEnv: {},
      workspaceStorage: "emptydir",
      pvcStorageClass: "standard",
      resources: {},
      idleTtlSeconds: 30 * 60,
      ...opts,
    };

    if (this.opts.idleTtlSeconds > 0) {
      this.cleanupTimer = setInterval(() => this.cleanupIdlePods(), 5 * 60 * 1000);
    }
  }

  // ── ContainerDriver ──────────────────────────────────────

  async getWorkerEndpoint(sessionId: string): Promise<WorkerEndpoint> {
    const podName = toK8sName(`s-${sessionId}`);

    const cached = this.cache.get(sessionId);
    if (cached && await this.isHealthy(cached.endpoint)) {
      cached.lastUsedAt = Date.now();
      return cached.endpoint;
    }

    await this.reconcilePod(podName, sessionId);
    await this.waitForPodReady(podName, 90);

    const port = this.opts.workerPort;
    const endpoint: WorkerEndpoint = {
      url: `http://${podName}.${this.opts.namespace}.svc.cluster.local:${port}`,
      containerId: podName,
    };

    this.cache.set(sessionId, { endpoint, lastUsedAt: Date.now() });
    return endpoint;
  }

  async releaseWorker(sessionId: string): Promise<void> {
    const entry = this.cache.get(sessionId);
    if (entry) {
      await this.deletePodAndService(entry.endpoint.containerId);
      this.cache.delete(sessionId);
    }
  }

  async isHealthy(endpoint: WorkerEndpoint): Promise<boolean> {
    try {
      const res = await fetch(`${endpoint.url}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Pod lifecycle ────────────────────────────────────────

  private async reconcilePod(podName: string, sessionId: string) {
    try {
      const { body } = await this.k8sCore.readNamespacedPod(podName, this.opts.namespace);
      const phase = body.status?.phase;
      if (phase === "Running" || phase === "Pending") {
        await this.ensureService(podName);
        return;
      }
      await this.deletePodAndService(podName);
    } catch (e: any) {
      if (e?.response?.statusCode !== 404 && e?.statusCode !== 404) throw e;
    }

    if (this.opts.workspaceStorage === "pvc") {
      await this.ensureWorkspacePVC(sessionId);
    }

    await this.createPod(podName, sessionId);
    await this.ensureService(podName);
  }

  private async createPod(podName: string, sessionId: string) {
    const port = this.opts.workerPort;
    const res = this.opts.resources;

    const envVars: k8s.V1EnvVar[] = [
      { name: "WORKSPACE_DIR", value: "/workspace" },
      ...Object.entries(this.opts.workerEnv).map(([name, value]) => ({ name, value })),
    ];

    const volumeSpec = this.buildVolume(sessionId);

    const pod: k8s.V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: this.opts.namespace,
        labels: {
          app: "anywork-worker",
          "anywork/pod-name": podName,
          "anywork/session-id": sanitizeLabel(sessionId),
        },
        annotations: {
          "anywork/created-at": new Date().toISOString(),
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [{
          name: "worker",
          image: this.opts.workerImage,
          ports: [{ containerPort: port, name: "http" }],
          env: envVars,
          resources: {
            requests: {
              cpu: res.cpuRequest ?? "250m",
              memory: res.memoryRequest ?? "512Mi",
            },
            limits: {
              cpu: res.cpuLimit ?? "2000m",
              memory: res.memoryLimit ?? "2Gi",
            },
          },
          readinessProbe: {
            httpGet: { path: "/health", port: port as any },
            initialDelaySeconds: 3,
            periodSeconds: 3,
            failureThreshold: 20,
          },
          livenessProbe: {
            httpGet: { path: "/health", port: port as any },
            initialDelaySeconds: 10,
            periodSeconds: 15,
          },
          volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
        }],
        volumes: [volumeSpec],
      },
    };

    await this.k8sCore.createNamespacedPod(this.opts.namespace, pod);
  }

  private async ensureService(podName: string) {
    try {
      await this.k8sCore.readNamespacedService(podName, this.opts.namespace);
      return;
    } catch (e: any) {
      if (e?.response?.statusCode !== 404 && e?.statusCode !== 404) throw e;
    }

    const svc: k8s.V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: podName,
        namespace: this.opts.namespace,
        labels: { app: "anywork-worker" },
      },
      spec: {
        selector: { "anywork/pod-name": podName },
        ports: [{ port: this.opts.workerPort, targetPort: this.opts.workerPort as any, name: "http" }],
        type: "ClusterIP",
      },
    };

    await this.k8sCore.createNamespacedService(this.opts.namespace, svc);
  }

  private async ensureWorkspacePVC(sessionId: string) {
    const pvcName = `ws-${sanitizeLabel(sessionId)}`;
    try {
      await this.k8sCore.readNamespacedPersistentVolumeClaim(pvcName, this.opts.namespace);
      return;
    } catch (e: any) {
      if (e?.response?.statusCode !== 404 && e?.statusCode !== 404) throw e;
    }

    const pvc: k8s.V1PersistentVolumeClaim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: pvcName, namespace: this.opts.namespace },
      spec: {
        accessModes: ["ReadWriteOnce"],
        storageClassName: this.opts.pvcStorageClass,
        resources: { requests: { storage: "5Gi" } },
      },
    };

    await this.k8sCore.createNamespacedPersistentVolumeClaim(this.opts.namespace, pvc);
  }

  private async deletePodAndService(podName: string) {
    const ns = this.opts.namespace;
    await Promise.allSettled([
      this.k8sCore.deleteNamespacedPod(podName, ns),
      this.k8sCore.deleteNamespacedService(podName, ns),
    ]);
  }

  // ── Helpers ──────────────────────────────────────────────

  private buildVolume(sessionId: string): k8s.V1Volume {
    if (this.opts.workspaceStorage === "pvc") {
      return {
        name: "workspace",
        persistentVolumeClaim: { claimName: `ws-${sanitizeLabel(sessionId)}` },
      };
    }
    return { name: "workspace", emptyDir: {} };
  }

  private async waitForPodReady(podName: string, timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      try {
        const { body } = await this.k8sCore.readNamespacedPod(podName, this.opts.namespace);
        const phase = body.status?.phase;
        if (phase === "Failed" || phase === "Succeeded") {
          throw new Error(`Worker pod ${podName} entered terminal phase: ${phase}`);
        }
        if (phase === "Running") {
          const statuses = body.status?.containerStatuses ?? [];
          if (statuses.length > 0 && statuses.every((cs) => cs.ready)) return;
        }
      } catch (e: any) {
        if (e.message?.includes("terminal phase")) throw e;
      }
      await sleep(2000);
    }
    throw new Error(`Worker pod ${podName} did not become ready within ${timeoutSeconds}s`);
  }

  private async cleanupIdlePods() {
    const now = Date.now();
    const ttlMs = this.opts.idleTtlSeconds * 1000;
    for (const [key, entry] of this.cache) {
      if (now - entry.lastUsedAt > ttlMs) {
        console.log(`[K8s] Cleaning up idle pod: ${entry.endpoint.containerId}`);
        await this.deletePodAndService(entry.endpoint.containerId);
        this.cache.delete(key);
      }
    }
  }
}

// ── Utility ────────────────────────────────────────────────

function toK8sName(key: string): string {
  const sanitized = key
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `w-${sanitized}`.slice(0, 63);
}

function sanitizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_.]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 63);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
