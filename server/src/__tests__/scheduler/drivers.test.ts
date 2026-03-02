import { describe, it, expect, vi, beforeEach } from "vitest";
import { StaticDriver } from "../../scheduler/drivers/static";

// ── Mock child_process for DockerDriver ────────────────────
vi.mock("child_process", () => ({
  execSync: vi.fn().mockReturnValue(Buffer.from("abc123def456\n")),
  exec: vi.fn(),
}));

// ── Mock fetch for health checks ───────────────────────────
vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("no network")));

import { DockerDriver } from "../../scheduler/drivers/docker";
import { execSync } from "child_process";

describe("StaticDriver", () => {
  it("should return the same endpoint for any sessionId", async () => {
    const driver = new StaticDriver("http://worker:8080");
    const ep1 = await driver.getWorkerEndpoint("session-1");
    const ep2 = await driver.getWorkerEndpoint("session-2");

    expect(ep1.url).toBe("http://worker:8080");
    expect(ep2.url).toBe("http://worker:8080");
    expect(ep1.containerId).toBe("static-worker");
    expect(ep2.containerId).toBe("static-worker");
  });

  it("should return * mapping from listEndpoints", () => {
    const driver = new StaticDriver("http://worker:8080");
    const map = driver.listEndpoints();
    expect(map.size).toBe(1);
    expect(map.get("*")).toEqual({ url: "http://worker:8080", containerId: "static-worker" });
  });

  it("should have no-op releaseWorker", async () => {
    const driver = new StaticDriver("http://worker:8080");
    await expect(driver.releaseWorker("any")).resolves.toBeUndefined();
  });
});

describe("DockerDriver", () => {
  let driver: DockerDriver;

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock fetch to return healthy response for waitForReady
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    driver = new DockerDriver({
      image: "anywork-worker:latest",
      dataDir: "/tmp/test-data",
      workerPort: 8080,
      anthropicApiKey: "sk-test",
      defaultModel: "claude-sonnet",
    });
  });

  it("should assign different ports for different sessions", async () => {
    const ep1 = await driver.getWorkerEndpoint("session-a");
    const ep2 = await driver.getWorkerEndpoint("session-b");

    expect(ep1.url).not.toBe(ep2.url);
    // Ports should be incrementing
    const port1 = parseInt(ep1.url.split(":").pop()!);
    const port2 = parseInt(ep2.url.split(":").pop()!);
    expect(port2).toBe(port1 + 1);
  });

  it("should mount workspace directory for session isolation", async () => {
    await driver.getWorkerEndpoint("sess-abc");

    // Check execSync was called with -v flag containing session-specific path
    const calls = (execSync as any).mock.calls;
    const dockerRunCall = calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("docker run")
    );
    expect(dockerRunCall).toBeDefined();
    expect(dockerRunCall[0]).toContain("-v /tmp/test-data/sess-abc:/workspace");
  });

  it("should name containers with session id", async () => {
    await driver.getWorkerEndpoint("my-session");

    const calls = (execSync as any).mock.calls;
    const dockerRunCall = calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("docker run")
    );
    expect(dockerRunCall[0]).toContain("--name anywork-worker-my-session");
  });

  it("should reuse endpoint when container is healthy", async () => {
    const ep1 = await driver.getWorkerEndpoint("reuse-session");

    // Reset mock to track new calls
    (execSync as any).mockClear();

    const ep2 = await driver.getWorkerEndpoint("reuse-session");

    expect(ep1.url).toBe(ep2.url);
    // Should NOT have called docker run again
    const dockerRunCalls = (execSync as any).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("docker run")
    );
    expect(dockerRunCalls.length).toBe(0);
  });

  it("should execute docker stop + rm on releaseWorker", async () => {
    await driver.getWorkerEndpoint("release-session");
    (execSync as any).mockClear();

    await driver.releaseWorker("release-session");

    const calls = (execSync as any).mock.calls;
    const stopCall = calls.find((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("docker stop")
    );
    expect(stopCall).toBeDefined();
    expect(stopCall[0]).toContain("anywork-worker-release-session");
  });

  it("should re-create container when health check fails", async () => {
    // First call: healthy
    const ep1 = await driver.getWorkerEndpoint("flaky-session");
    (execSync as any).mockClear();

    // Now make health check fail
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: false }) // isHealthy fails
      .mockResolvedValue({ ok: true })      // waitForReady succeeds
    );

    const ep2 = await driver.getWorkerEndpoint("flaky-session");

    // Should have called docker run again
    const dockerRunCalls = (execSync as any).mock.calls.filter((c: any[]) =>
      typeof c[0] === "string" && c[0].includes("docker run")
    );
    expect(dockerRunCalls.length).toBe(1);
    // New port should be different
    expect(ep2.url).not.toBe(ep1.url);
  });

  it("should list active endpoints", async () => {
    await driver.getWorkerEndpoint("list-s1");
    await driver.getWorkerEndpoint("list-s2");

    const endpoints = driver.listEndpoints();
    expect(endpoints.size).toBe(2);
    expect(endpoints.has("list-s1")).toBe(true);
    expect(endpoints.has("list-s2")).toBe(true);
  });
});
