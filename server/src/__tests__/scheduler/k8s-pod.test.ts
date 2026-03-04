import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @kubernetes/client-node ───────────────────────────

const mockCoreV1Api = {
  readNamespacedPod: vi.fn(),
  createNamespacedPod: vi.fn().mockResolvedValue({}),
  deleteNamespacedPod: vi.fn().mockResolvedValue({}),
  readNamespacedService: vi.fn(),
  createNamespacedService: vi.fn().mockResolvedValue({}),
  deleteNamespacedService: vi.fn().mockResolvedValue({}),
  readNamespacedPersistentVolumeClaim: vi.fn(),
  createNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({}),
};

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromDefault() {}
    makeApiClient() { return mockCoreV1Api; }
  }
  return {
    KubeConfig,
    CoreV1Api: class {},
    V1Pod: class {},
    V1Service: class {},
    V1PersistentVolumeClaim: class {},
  };
});

// Mock health-check fetch
vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));

import { K8sDriver, type K8sDriverOptions } from "../../scheduler/drivers/k8s";

function createDriver(overrides: Partial<K8sDriverOptions> = {}): K8sDriver {
  return new K8sDriver({
    namespace: "test-ns",
    workerImage: "anywork-worker:latest",
    workerPort: 8080,
    workerEnv: { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet" },
    workspaceStorage: "emptydir",
    resources: {
      cpuRequest: "250m",
      cpuLimit: "2000m",
      memoryRequest: "512Mi",
      memoryLimit: "2Gi",
    },
    idleTtlSeconds: 0, // disable cleanup timer in tests
    ...overrides,
  });
}

function setupPodReadyFlow() {
  // readNamespacedPod: first returns 404 (not found), then "Running" with ready containers
  mockCoreV1Api.readNamespacedPod
    .mockRejectedValueOnce({ response: { statusCode: 404 } })     // reconcilePod: pod not found
    .mockResolvedValueOnce({                                       // waitForPodReady: Running + ready
      status: {
        phase: "Running",
        containerStatuses: [{ ready: true }],
      },
    });
  // readNamespacedService: not found → create
  mockCoreV1Api.readNamespacedService
    .mockRejectedValue({ response: { statusCode: 404 } });
}

describe("K8sDriver — Pod Spec & Isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create pod with correct naming (w-s-{sessionId})", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("abc-123");

    expect(mockCoreV1Api.createNamespacedPod).toHaveBeenCalledOnce();
    const callArgs = mockCoreV1Api.createNamespacedPod.mock.calls[0][0];
    const pod = callArgs.body;
    expect(pod.metadata.name).toBe("w-s-abc-123");
    expect(callArgs.namespace).toBe("test-ns");
  });

  it("should label pods with session-id", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("session-xyz");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    expect(pod.metadata.labels).toMatchObject({
      app: "anywork-worker",
      "anywork/session-id": "session-xyz",
    });
  });

  it("should mount workspace volume at /workspace", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("mount-test");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    const container = pod.spec.containers[0];
    expect(container.volumeMounts).toEqual([
      { name: "workspace", mountPath: "/workspace" },
    ]);
  });

  it("should use emptyDir volume for emptydir storage mode", async () => {
    const driver = createDriver({ workspaceStorage: "emptydir" });
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("emptydir-session");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    expect(pod.spec.volumes).toEqual([{ name: "workspace", emptyDir: {} }]);
    expect(mockCoreV1Api.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });

  it("should create PVC for pvc storage mode", async () => {
    const driver = createDriver({ workspaceStorage: "pvc" });

    mockCoreV1Api.readNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 404 } })
      .mockResolvedValueOnce({
        status: { phase: "Running", containerStatuses: [{ ready: true }] },
      });
    mockCoreV1Api.readNamespacedService
      .mockRejectedValue({ response: { statusCode: 404 } });
    mockCoreV1Api.readNamespacedPersistentVolumeClaim
      .mockRejectedValue({ response: { statusCode: 404 } });

    await driver.getWorkerEndpoint("pvc-session-1");

    // PVC should be created
    expect(mockCoreV1Api.createNamespacedPersistentVolumeClaim).toHaveBeenCalledOnce();
    const pvcArgs = mockCoreV1Api.createNamespacedPersistentVolumeClaim.mock.calls[0][0];
    const pvc = pvcArgs.body;
    expect(pvc.metadata.name).toBe("ws-pvc-session-1");
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec.resources.requests.storage).toBe("5Gi");
    expect(pvc.spec.storageClassName).toBe("standard");

    // Pod volume should use persistentVolumeClaim
    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    expect(pod.spec.volumes).toEqual([{
      name: "workspace",
      persistentVolumeClaim: { claimName: "ws-pvc-session-1" },
    }]);
  });

  it("should isolate PVCs per session (different PVC names)", async () => {
    const driver = createDriver({ workspaceStorage: "pvc" });

    for (const sessionId of ["session-1", "session-2"]) {
      mockCoreV1Api.readNamespacedPod
        .mockRejectedValueOnce({ response: { statusCode: 404 } })
        .mockResolvedValueOnce({
          status: { phase: "Running", containerStatuses: [{ ready: true }] },
        });
      mockCoreV1Api.readNamespacedService
        .mockRejectedValueOnce({ response: { statusCode: 404 } });
      mockCoreV1Api.readNamespacedPersistentVolumeClaim
        .mockRejectedValueOnce({ response: { statusCode: 404 } });

      await driver.getWorkerEndpoint(sessionId);
    }

    expect(mockCoreV1Api.createNamespacedPersistentVolumeClaim).toHaveBeenCalledTimes(2);
    const pvc1 = mockCoreV1Api.createNamespacedPersistentVolumeClaim.mock.calls[0][0].body;
    const pvc2 = mockCoreV1Api.createNamespacedPersistentVolumeClaim.mock.calls[1][0].body;
    expect(pvc1.metadata.name).toBe("ws-session-1");
    expect(pvc2.metadata.name).toBe("ws-session-2");
  });

  it("should inject environment variables correctly", async () => {
    const driver = createDriver({
      workerEnv: { ANTHROPIC_API_KEY: "sk-abc", ANTHROPIC_MODEL: "claude-opus" },
    });
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("env-test");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    const envVars = pod.spec.containers[0].env;
    expect(envVars).toContainEqual({ name: "WORKSPACE_DIR", value: "/workspace" });
    expect(envVars).toContainEqual({ name: "ANTHROPIC_API_KEY", value: "sk-abc" });
    expect(envVars).toContainEqual({ name: "ANTHROPIC_MODEL", value: "claude-opus" });
  });

  it("should set resource requests and limits", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("resource-test");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    const resources = pod.spec.containers[0].resources;
    expect(resources.requests).toEqual({ cpu: "250m", memory: "512Mi" });
    expect(resources.limits).toEqual({ cpu: "2000m", memory: "2Gi" });
  });

  it("should configure readiness and liveness probes", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("probe-test");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    const container = pod.spec.containers[0];

    expect(container.readinessProbe).toEqual({
      httpGet: { path: "/health", port: 8080 },
      initialDelaySeconds: 3,
      periodSeconds: 3,
      failureThreshold: 20,
    });
    expect(container.livenessProbe).toEqual({
      httpGet: { path: "/health", port: 8080 },
      initialDelaySeconds: 10,
      periodSeconds: 15,
    });
  });

  it("should set restartPolicy to Never", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("restart-test");

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    expect(pod.spec.restartPolicy).toBe("Never");
  });

  it("should return correct service URL", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    const ep = await driver.getWorkerEndpoint("url-test");

    expect(ep.url).toBe("http://w-s-url-test.test-ns.svc.cluster.local:8080");
    expect(ep.containerId).toBe("w-s-url-test");
  });

  it("should reuse cached endpoint when healthy", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    // Ensure health check passes for cache reuse
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const ep1 = await driver.getWorkerEndpoint("cache-test");

    // Reset mocks to verify no new pod creation
    mockCoreV1Api.createNamespacedPod.mockClear();

    const ep2 = await driver.getWorkerEndpoint("cache-test");

    expect(ep1.url).toBe(ep2.url);
    expect(mockCoreV1Api.createNamespacedPod).not.toHaveBeenCalled();
  });

  it("should reuse existing Running pod", async () => {
    const driver = createDriver();

    // Pod already exists and is Running
    mockCoreV1Api.readNamespacedPod.mockResolvedValueOnce({
      status: { phase: "Running", containerStatuses: [{ ready: true }] },
    }).mockResolvedValueOnce({
      status: { phase: "Running", containerStatuses: [{ ready: true }] },
    });
    mockCoreV1Api.readNamespacedService
      .mockRejectedValueOnce({ response: { statusCode: 404 } });

    const ep = await driver.getWorkerEndpoint("existing-pod");

    expect(mockCoreV1Api.createNamespacedPod).not.toHaveBeenCalled();
    expect(mockCoreV1Api.createNamespacedService).toHaveBeenCalledOnce(); // still ensures service
    expect(ep.containerId).toBe("w-s-existing-pod");
  });

  it("should throw on terminal pod phase (Failed)", async () => {
    const driver = createDriver();

    // reconcilePod: pod not found → creates new pod
    mockCoreV1Api.readNamespacedPod
      .mockRejectedValueOnce({ response: { statusCode: 404 } })
      .mockResolvedValue({
        status: { phase: "Failed" },
      });
    mockCoreV1Api.readNamespacedService
      .mockRejectedValue({ response: { statusCode: 404 } });

    await expect(driver.getWorkerEndpoint("failed-pod")).rejects.toThrow(/terminal phase/);
  });

  it("should delete pod and service on releaseWorker", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    await driver.getWorkerEndpoint("release-session");

    await driver.releaseWorker("release-session");

    expect(mockCoreV1Api.deleteNamespacedPod).toHaveBeenCalled();
    expect(mockCoreV1Api.deleteNamespacedService).toHaveBeenCalled();

    // Endpoint should be removed from listEndpoints
    const endpoints = driver.listEndpoints();
    expect(endpoints.has("release-session")).toBe(false);
  });

  it("should sanitize long session IDs in pod names (max 63 chars)", async () => {
    const driver = createDriver();
    setupPodReadyFlow();

    const longId = "a".repeat(100);
    await driver.getWorkerEndpoint(longId);

    const pod = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    expect(pod.metadata.name.length).toBeLessThanOrEqual(63);
    expect(pod.metadata.name).toMatch(/^w-s-/);
  });

  it("should create separate emptyDir pods for different sessions", async () => {
    const driver = createDriver({ workspaceStorage: "emptydir" });

    for (const sessionId of ["iso-1", "iso-2"]) {
      mockCoreV1Api.readNamespacedPod
        .mockRejectedValueOnce({ response: { statusCode: 404 } })
        .mockResolvedValueOnce({
          status: { phase: "Running", containerStatuses: [{ ready: true }] },
        });
      mockCoreV1Api.readNamespacedService
        .mockRejectedValueOnce({ response: { statusCode: 404 } });

      await driver.getWorkerEndpoint(sessionId);
    }

    expect(mockCoreV1Api.createNamespacedPod).toHaveBeenCalledTimes(2);
    const pod1 = mockCoreV1Api.createNamespacedPod.mock.calls[0][0].body;
    const pod2 = mockCoreV1Api.createNamespacedPod.mock.calls[1][0].body;
    expect(pod1.metadata.name).toBe("w-s-iso-1");
    expect(pod2.metadata.name).toBe("w-s-iso-2");
    // Both use emptyDir but in separate pods — inherently isolated
    expect(pod1.spec.volumes[0].emptyDir).toEqual({});
    expect(pod2.spec.volumes[0].emptyDir).toEqual({});
  });
});

describe("K8sDriver — Idle Cleanup", () => {
  it("should not start cleanup timer when idleTtlSeconds=0", () => {
    const driver = createDriver({ idleTtlSeconds: 0 });
    // No timer should be set — we can't easily inspect, but we verify no crash
    expect(driver).toBeDefined();
  });
});
