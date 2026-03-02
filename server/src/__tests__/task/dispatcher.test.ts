import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "../../db/schema";
import { createTask, getTask, getTaskLogs } from "../../db/tasks";
import type { Channel } from "../../channel/types";
import type { ContainerDriver, WorkerEndpoint } from "../../scheduler/drivers/interface";

// ── Mock container driver ──────────────────────────────────
const mockEndpoint: WorkerEndpoint = { url: "http://mock-worker:8080", containerId: "mock-c1" };
const mockDriver: ContainerDriver = {
  getWorkerEndpoint: vi.fn().mockResolvedValue(mockEndpoint),
  releaseWorker: vi.fn().mockResolvedValue(undefined),
  isHealthy: vi.fn().mockResolvedValue(true),
};

vi.mock("../../scheduler/container", () => ({
  getContainerDriver: () => mockDriver,
}));

// ── Import dispatch after mocking ──────────────────────────
import { dispatch } from "../../task/dispatcher";

// ── Helpers ────────────────────────────────────────────────

function createSSEBody(events: Array<{ event: string; data: object | string }>): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => {
      const dataStr = typeof e.data === "string" ? e.data : JSON.stringify(e.data);
      return `event:${e.event}\ndata:${dataStr}\n\n`;
    })
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockFetch(handlers: Record<string, () => Response>) {
  return vi.fn((input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) return Promise.resolve(handler());
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  });
}

function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    type: "test",
    defaults: { skills: [], mcpServers: [] },
    verify: vi.fn().mockResolvedValue(true),
    toTaskRequest: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function ensureSession(sessionId: string) {
  const db = getDb();
  const exists = db.prepare("SELECT id FROM sessions WHERE id = ?").get(sessionId);
  if (!exists) {
    db.prepare("INSERT INTO sessions (id, channel_type) VALUES (?, ?)").run(sessionId, "test");
  }
}

function createTestTask(overrides: Partial<{
  id: string; sessionId: string; message: string; skills: string[]; mcpServers: object[];
  pushNotification: object;
}> = {}) {
  const sessionId = overrides.sessionId ?? "test-session";
  ensureSession(sessionId);
  return createTask({
    id: overrides.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    sessionId,
    channelType: "test",
    message: overrides.message ?? "hello",
    skills: overrides.skills,
    mcpServers: overrides.mcpServers,
    pushNotification: overrides.pushNotification,
  });
}

describe("Dispatcher", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Re-setup mock driver after restoreAllMocks
    (mockDriver.getWorkerEndpoint as any) = vi.fn().mockResolvedValue(mockEndpoint);
    (mockDriver.releaseWorker as any) = vi.fn().mockResolvedValue(undefined);
    (mockDriver.isHealthy as any) = vi.fn().mockResolvedValue(true);
  });

  it("should complete normal flow: getWorkerEndpoint → /prepare (skipped) → /chat(SSE) → completed", async () => {
    const task = createTestTask();
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "text", data: { content: "Hello back" } },
        { event: "done", data: { content: "", metadata: { cost_usd: 0.01, num_turns: 1, duration_ms: 500 } } },
      ])),
    }));

    await dispatch(task, channel);

    const finished = getTask(task.id);
    expect(finished!.status).toBe("completed");
    expect(finished!.result).toBe("Hello back");
    expect(finished!.cost_usd).toBe(0.01);
    expect(finished!.num_turns).toBe(1);
    expect(finished!.duration_ms).toBe(500);
    expect(finished!.worker_id).toBe("mock-c1");

    // /prepare should NOT have been called since no skills/mcp_servers
    const fetchCalls = (globalThis.fetch as any).mock.calls;
    const prepareCall = fetchCalls.find((c: any[]) =>
      (typeof c[0] === "string" ? c[0] : "").includes("/prepare")
    );
    expect(prepareCall).toBeUndefined();
  });

  it("should call /prepare when task has skills", async () => {
    const task = createTestTask({ skills: ["code-review"] });
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/prepare": () => new Response("OK", { status: 200 }),
      "/chat": () => new Response(createSSEBody([
        { event: "done", data: { content: "" } },
      ])),
    }));

    await dispatch(task, channel);

    const fetchCalls = (globalThis.fetch as any).mock.calls;
    const prepareCall = fetchCalls.find((c: any[]) =>
      (typeof c[0] === "string" ? c[0] : "").includes("/prepare")
    );
    expect(prepareCall).toBeDefined();

    const finished = getTask(task.id);
    expect(finished!.status).toBe("completed");
  });

  it("should write task_logs for SSE events", async () => {
    const task = createTestTask();
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "text", data: { content: "chunk1" } },
        { event: "text", data: { content: "chunk2" } },
        { event: "done", data: { content: "" } },
      ])),
    }));

    await dispatch(task, channel);

    const logs = getTaskLogs(task.id, -1);
    expect(logs.length).toBe(3);
    expect(logs[0].type).toBe("text");
    expect(logs[0].content).toBe("chunk1");
    expect(logs[0].seq).toBe(0);
    expect(logs[1].type).toBe("text");
    expect(logs[1].content).toBe("chunk2");
    expect(logs[1].seq).toBe(1);
    expect(logs[2].type).toBe("done");
    expect(logs[2].seq).toBe(2);
  });

  it("should forward SSE events to WebSocket", async () => {
    const task = createTestTask();
    const channel = createMockChannel();
    const wsSend = vi.fn();
    const ws = { readyState: 1, OPEN: 1, send: wsSend } as any;

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "text", data: { content: "Hi" } },
        { event: "done", data: { content: "" } },
      ])),
    }));

    await dispatch(task, channel, ws);

    expect(wsSend).toHaveBeenCalled();
    const messages = wsSend.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    const textMsg = messages.find((m: any) => m.type === "text");
    expect(textMsg).toBeDefined();
    expect(textMsg.content).toBe("Hi");
  });

  it("should mark task as failed on SSE error event", async () => {
    const task = createTestTask();
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "error", data: { content: "Worker crashed" } },
      ])),
    }));

    await dispatch(task, channel);

    const finished = getTask(task.id);
    expect(finished!.status).toBe("failed");
    expect(finished!.error).toBe("Worker crashed");
  });

  it("should mark task as failed when /chat returns non-200", async () => {
    const task = createTestTask();
    const channel = createMockChannel();
    const wsSend = vi.fn();
    const ws = { readyState: 1, OPEN: 1, send: wsSend } as any;

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response("Internal Server Error", { status: 500 }),
    }));

    await dispatch(task, channel, ws);

    const finished = getTask(task.id);
    expect(finished!.status).toBe("failed");
    expect(finished!.error).toMatch(/Worker \/chat failed: 500/);

    // Should send error + done to WebSocket
    const messages = wsSend.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(messages.some((m: any) => m.type === "error")).toBe(true);
    expect(messages.some((m: any) => m.type === "done")).toBe(true);
  });

  it("should mark task as failed when /prepare returns non-200", async () => {
    const task = createTestTask({ skills: ["some-skill"] });
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/prepare": () => new Response("Bad Request", { status: 400 }),
    }));

    await dispatch(task, channel);

    const finished = getTask(task.id);
    expect(finished!.status).toBe("failed");
    expect(finished!.error).toMatch(/Worker \/prepare failed/);
  });

  it("should call channel.deliver() on completed oneshot task", async () => {
    const deliverFn = vi.fn().mockResolvedValue(undefined);
    const channel = createMockChannel({ deliver: deliverFn });
    const task = createTestTask();

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "text", data: { content: "result" } },
        { event: "done", data: { content: "" } },
      ])),
    }));

    await dispatch(task, channel);

    expect(deliverFn).toHaveBeenCalledOnce();
    expect(deliverFn.mock.calls[0][0].status).toBe("completed");
    expect(deliverFn.mock.calls[0][0].result).toBe("result");
  });

  it("should send push notification on completed task", async () => {
    const webhookUrl = "https://example.com/webhook";
    const task = createTestTask({
      pushNotification: { webhookUrl, authHeader: "Bearer abc" },
    });
    const channel = createMockChannel();

    const fetchMock = mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "done", data: { content: "" } },
      ])),
      "example.com/webhook": () => new Response("OK"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await dispatch(task, channel);

    const webhookCall = fetchMock.mock.calls.find((c: any[]) =>
      (typeof c[0] === "string" ? c[0] : "").includes("example.com/webhook")
    );
    expect(webhookCall).toBeDefined();
    const init = webhookCall![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer abc");
  });

  it("should handle stream without explicit done event (auto-complete)", async () => {
    const task = createTestTask();
    const channel = createMockChannel();

    vi.stubGlobal("fetch", mockFetch({
      "/chat": () => new Response(createSSEBody([
        { event: "text", data: { content: "partial" } },
        // No done event — stream just ends
      ])),
    }));

    await dispatch(task, channel);

    const finished = getTask(task.id);
    expect(finished!.status).toBe("completed");
    expect(finished!.result).toBe("partial");
  });
});
