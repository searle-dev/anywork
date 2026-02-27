/**
 * Kubernetes container driver.
 *
 * Scheduling model: per-session Pod.
 *   - Each chat session gets a dedicated K8s Pod + ClusterIP Service.
 *   - The Pod is created with SKILLS and MCP_SERVERS env vars so the
 *     worker can load the correct tools at startup.
 *   - Workspace is an emptyDir by default (ephemeral per session).
 *     Set K8S_WORKSPACE_STORAGE=pvc to use per-user PersistentVolumeClaims.
 *
 * Requirements:
 *   - Server must run inside the cluster (in-cluster service account) OR
 *     have ~/.kube/config with appropriate cluster access.
 *   - RBAC: the server service account needs create/get/delete on
 *     pods and services in the target namespace (see deploy/k8s/rbac.yaml).
 */

import * as k8s from "@kubernetes/client-node";
import { ContainerDriver, MCPServerConfig, WorkerEndpoint, WorkerSpec } from "./interface";

export interface K8sDriverOptions {
  namespace: string;
  workerImage: string;
  anthropicApiKey: string;
  apiKey: string;
  apiBaseUrl: string;
  defaultModel: string;
  /** "emptydir" (default) or "pvc" */
  workspaceStorage: "emptydir" | "pvc";
  /** Storage class for PVC (required when workspaceStorage="pvc") */
  pvcStorageClass?: string;
  /** CPU/memory limits for worker pods */
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
  /** routingKey → {endpoint, lastUsedAt} */
  private readonly cache = new Map<string, CacheEntry>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(opts: K8sDriverOptions) {
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    this.k8sCore = kc.makeApiClient(k8s.CoreV1Api);

    this.opts = {
      workspaceStorage: "emptydir",
      pvcStorageClass: "standard",
      resources: {},
      idleTtlSeconds: 30 * 60,
      ...opts,
    };

    if (this.opts.idleTtlSeconds > 0) {
      // Scan for idle pods every 5 minutes
      this.cleanupTimer = setInterval(() => this.cleanupIdlePods(), 5 * 60 * 1000);
    }
  }

  // ---------------------------------------------------------------------------
  // ContainerDriver implementation
  // ---------------------------------------------------------------------------

  async getWorkerEndpoint(userId: string, spec?: WorkerSpec): Promise<WorkerEndpoint> {
    const routingKey = spec?.sessionId
      ? `session-${spec.sessionId}`
      : `user-${userId}`;
    const podName = toK8sName(routingKey);

    // Return cached healthy endpoint
    const cached = this.cache.get(routingKey);
    if (cached && await this.isHealthy(cached.endpoint)) {
      cached.lastUsedAt = Date.now();
      return cached.endpoint;
    }

    // Create (or recreate) the pod and service
    await this.reconcilePod(podName, userId, spec);
    await this.waitForPodReady(podName, 90);

    const endpoint: WorkerEndpoint = {
      url: `http://${podName}.${this.opts.namespace}.svc.cluster.local:8080`,
      containerId: podName,
    };

    this.cache.set(routingKey, { endpoint, lastUsedAt: Date.now() });
    return endpoint;
  }

  async releaseWorker(userId: string): Promise<void> {
    const keysToDelete: string[] = [];
    for (const [key] of this.cache) {
      if (key === `user-${userId}` || key.includes(userId)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      const entry = this.cache.get(key)!;
      await this.deletePodAndService(entry.endpoint.containerId);
      this.cache.delete(key);
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

  // ---------------------------------------------------------------------------
  // Pod lifecycle
  // ---------------------------------------------------------------------------

  private async reconcilePod(podName: string, userId: string, spec?: WorkerSpec) {
    // Check existing pod phase
    try {
      const { body } = await this.k8sCore.readNamespacedPod(podName, this.opts.namespace);
      const phase = body.status?.phase;
      if (phase === "Running" || phase === "Pending") {
        // Pod exists, also ensure service exists
        await this.ensureService(podName);
        return;
      }
      // Pod in terminal state — delete and recreate
      await this.deletePodAndService(podName);
    } catch (e: any) {
      if (e?.response?.statusCode !== 404 && e?.statusCode !== 404) throw e;
    }

    // Ensure workspace PVC for user (if pvc mode)
    if (this.opts.workspaceStorage === "pvc") {
      await this.ensureWorkspacePVC(userId);
    }

    await this.createPod(podName, userId, spec);
    await this.ensureService(podName);
  }

  private async createPod(podName: string, userId: string, spec?: WorkerSpec) {
    const envVars = this.buildEnvVars(spec);
    const volumeSpec = this.buildVolume(userId);
    const res = this.opts.resources;

    const pod: k8s.V1Pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: podName,
        namespace: this.opts.namespace,
        labels: {
          app: "anywork-worker",
          "anywork/pod-name": podName,
          "anywork/user-id": sanitizeLabel(userId),
          ...(spec?.sessionId && {
            "anywork/session-id": sanitizeLabel(spec.sessionId),
          }),
        },
        annotations: {
          "anywork/created-at": new Date().toISOString(),
          ...(spec?.skills?.length && {
            "anywork/skills": spec.skills.join(","),
          }),
          ...(spec?.engine && {
            "anywork/engine": spec.engine,
          }),
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "worker",
            image: this.opts.workerImage,
            ports: [{ containerPort: 8080, name: "http" }],
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
              httpGet: { path: "/health", port: 8080 as any },
              initialDelaySeconds: 3,
              periodSeconds: 3,
              failureThreshold: 20,
            },
            livenessProbe: {
              httpGet: { path: "/health", port: 8080 as any },
              initialDelaySeconds: 10,
              periodSeconds: 15,
            },
            volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
          },
        ],
        volumes: [volumeSpec],
      },
    };

    await this.k8sCore.createNamespacedPod(this.opts.namespace, pod);
  }

  private async ensureService(podName: string) {
    try {
      await this.k8sCore.readNamespacedService(podName, this.opts.namespace);
      return; // Already exists
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
        ports: [{ port: 8080, targetPort: 8080 as any, name: "http" }],
        type: "ClusterIP",
      },
    };

    await this.k8sCore.createNamespacedService(this.opts.namespace, svc);
  }

  private async ensureWorkspacePVC(userId: string) {
    const pvcName = `workspace-${sanitizeLabel(userId)}`;
    try {
      await this.k8sCore.readNamespacedPersistentVolumeClaim(
        pvcName,
        this.opts.namespace
      );
      return; // Already exists
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

    await this.k8sCore.createNamespacedPersistentVolumeClaim(
      this.opts.namespace,
      pvc
    );
  }

  private async deletePodAndService(podName: string) {
    const ns = this.opts.namespace;
    await Promise.allSettled([
      this.k8sCore.deleteNamespacedPod(podName, ns),
      this.k8sCore.deleteNamespacedService(podName, ns),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildEnvVars(spec?: WorkerSpec): k8s.V1EnvVar[] {
    const env: k8s.V1EnvVar[] = [
      { name: "WORKSPACE_DIR", value: "/workspace" },
      { name: "ANTHROPIC_API_KEY", value: this.opts.anthropicApiKey },
      { name: "API_KEY", value: this.opts.apiKey },
      { name: "API_BASE_URL", value: this.opts.apiBaseUrl },
      { name: "DEFAULT_MODEL", value: this.opts.defaultModel },
      { name: "MODEL", value: this.opts.defaultModel },
    ];

    if (spec?.engine) {
      env.push({ name: "ENGINE", value: spec.engine });
    }
    if (spec?.skills?.length) {
      env.push({ name: "SKILLS", value: spec.skills.join(",") });
    }
    if (spec?.mcpServers?.length) {
      env.push({
        name: "MCP_SERVERS",
        value: JSON.stringify(spec.mcpServers),
      });
    }

    return env;
  }

  private buildVolume(userId: string): k8s.V1Volume {
    if (this.opts.workspaceStorage === "pvc") {
      return {
        name: "workspace",
        persistentVolumeClaim: {
          claimName: `workspace-${sanitizeLabel(userId)}`,
        },
      };
    }
    return { name: "workspace", emptyDir: {} };
  }

  private async waitForPodReady(podName: string, timeoutSeconds: number) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      try {
        const { body } = await this.k8sCore.readNamespacedPod(
          podName,
          this.opts.namespace
        );
        const phase = body.status?.phase;
        if (phase === "Failed" || phase === "Succeeded") {
          throw new Error(`Worker pod ${podName} entered terminal phase: ${phase}`);
        }
        if (phase === "Running") {
          const containerStatuses = body.status?.containerStatuses ?? [];
          const allReady = containerStatuses.length > 0 &&
            containerStatuses.every((cs) => cs.ready);
          if (allReady) return;
        }
      } catch (e: any) {
        if (e.message?.includes("terminal phase")) throw e;
      }
      await sleep(2000);
    }
    throw new Error(
      `Worker pod ${podName} did not become ready within ${timeoutSeconds}s`
    );
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

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Convert an arbitrary routing key to a valid K8s resource name (max 63 chars). */
function toK8sName(key: string): string {
  const sanitized = key
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  // Prefix with "w-" to ensure it starts with a letter, then truncate
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
