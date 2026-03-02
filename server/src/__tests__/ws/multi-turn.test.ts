import { describe, it, expect, vi, beforeEach } from "vitest";
import { getDb } from "../../db/schema";
import { listTasksBySession, getTaskLogs, getTask } from "../../db/tasks";
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

// ── Mock titleGen ──────────────────────────────────────────
const mockGenerateTitle = vi.fn().mockResolvedValue("Generated Title");
vi.mock("../../lib/titleGen", () => ({
  generateTitle: (...args: any[]) => mockGenerateTitle(...args),
}));

// ── Helpers ────────────────────────────────────────────────

let callCount = 0;

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

function setupFetchForMultipleTurns(turnResponses: string[]) {
  callCount = 0;
  vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/chat")) {
      const response = turnResponses[callCount] ?? "default response";
      callCount++;
      return Promise.resolve(new Response(createSSEBody([
        { event: "text", data: { content: response } },
        { event: "done", data: { content: "" } },
      ])));
    }
    return Promise.resolve(new Response("OK"));
  }));
}

// ── Import handleWebSocket after mocks ─────────────────────
import { handleWebSocket } from "../../ws/handler";

// Simulate WebSocket client
function createMockWs() {
  const messages: any[] = [];
  const handlers = new Map<string, Function[]>();
  const ws = {
    readyState: 1,
    OPEN: 1,
    send: vi.fn((data: string) => messages.push(JSON.parse(data))),
    on: vi.fn((event: string, handler: Function) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    }),
    emit(event: string, ...args: any[]) {
      for (const h of handlers.get(event) ?? []) h(...args);
    },
    messages,
  };
  // Patch the OPEN constant used by the real WebSocket module
  Object.defineProperty(ws, "OPEN", { value: 1 });
  return ws;
}

async function sendChat(ws: any, msg: { session_id?: string; message: string }) {
  const data = Buffer.from(JSON.stringify({ type: "chat", ...msg }));
  // Trigger the "message" handler
  const handlers = ws.on.mock.calls
    .filter((c: any[]) => c[0] === "message")
    .map((c: any[]) => c[1]);
  for (const h of handlers) {
    await h(data);
  }
}

describe("Multi-turn Conversation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callCount = 0;
  });

  it("should create two tasks under the same session for consecutive chats", async () => {
    setupFetchForMultipleTurns(["Response 1", "Response 2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    // First message — no session_id → auto-create
    await sendChat(ws, { message: "Hello" });

    // Extract session_id from session_created event
    const sessionCreated = ws.messages.find((m: any) => m.type === "session_created");
    expect(sessionCreated).toBeDefined();
    const sessionId = sessionCreated.session_id;

    // Second message — same session
    await sendChat(ws, { session_id: sessionId, message: "Follow up" });

    const tasks = listTasksBySession(sessionId);
    expect(tasks.length).toBe(2);
    expect(tasks[0].message).toBe("Hello");
    expect(tasks[1].message).toBe("Follow up");
    expect(tasks[0].session_id).toBe(sessionId);
    expect(tasks[1].session_id).toBe(sessionId);
  });

  it("should reuse the same worker endpoint for same session", async () => {
    setupFetchForMultipleTurns(["R1", "R2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "Turn 1" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;

    await sendChat(ws, { session_id: sessionId, message: "Turn 2" });

    // getWorkerEndpoint should be called with the same sessionId both times
    const calls = (mockDriver.getWorkerEndpoint as any).mock.calls;
    expect(calls.length).toBe(2);
    expect(calls[0][0]).toBe(sessionId);
    expect(calls[1][0]).toBe(sessionId);
  });

  it("should auto-create session on first chat without session_id", async () => {
    setupFetchForMultipleTurns(["Hello"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "First message" });

    const sessionCreated = ws.messages.find((m: any) => m.type === "session_created");
    expect(sessionCreated).toBeDefined();

    // Session should exist in DB
    const db = getDb();
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionCreated.session_id) as any;
    expect(session).toBeDefined();
    expect(session.channel_type).toBe("webchat");
  });

  it("should complete tasks sequentially (first done before second starts)", async () => {
    setupFetchForMultipleTurns(["R1", "R2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "Turn 1" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;

    const tasks1 = listTasksBySession(sessionId);
    expect(tasks1.length).toBe(1);
    expect(tasks1[0].status).toBe("completed");

    await sendChat(ws, { session_id: sessionId, message: "Turn 2" });

    const tasks2 = listTasksBySession(sessionId);
    expect(tasks2.length).toBe(2);
    expect(tasks2[0].status).toBe("completed");
    expect(tasks2[1].status).toBe("completed");
  });

  it("should update session last_active after each chat", async () => {
    setupFetchForMultipleTurns(["R1", "R2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "Turn 1" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;

    const db = getDb();
    const s1 = db.prepare("SELECT last_active FROM sessions WHERE id = ?").get(sessionId) as any;

    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 1100));

    await sendChat(ws, { session_id: sessionId, message: "Turn 2" });

    const s2 = db.prepare("SELECT last_active FROM sessions WHERE id = ?").get(sessionId) as any;
    expect(s2.last_active).toBeGreaterThanOrEqual(s1.last_active);
  });

  it("should trigger titleGen only on first chat (new session)", async () => {
    setupFetchForMultipleTurns(["R1", "R2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "First message" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;

    expect(mockGenerateTitle).toHaveBeenCalledOnce();
    expect(mockGenerateTitle).toHaveBeenCalledWith("First message");

    mockGenerateTitle.mockClear();
    await sendChat(ws, { session_id: sessionId, message: "Second message" });

    // Should NOT trigger titleGen again
    expect(mockGenerateTitle).not.toHaveBeenCalled();
  });

  it("should keep task_logs independent per task (seq starts from 0)", async () => {
    setupFetchForMultipleTurns(["R1", "R2"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "Turn 1" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;
    await sendChat(ws, { session_id: sessionId, message: "Turn 2" });

    const tasks = listTasksBySession(sessionId);
    expect(tasks.length).toBe(2);

    const logs1 = getTaskLogs(tasks[0].id, -1);
    const logs2 = getTaskLogs(tasks[1].id, -1);

    // Both should start from seq 0
    expect(logs1[0].seq).toBe(0);
    expect(logs2[0].seq).toBe(0);
    // Logs belong to their respective tasks
    expect(logs1.every((l) => l.task_id === tasks[0].id)).toBe(true);
    expect(logs2.every((l) => l.task_id === tasks[1].id)).toBe(true);
  });

  it("should handle ping/pong", async () => {
    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    const data = Buffer.from(JSON.stringify({ type: "ping" }));
    const handlers = ws.on.mock.calls
      .filter((c: any[]) => c[0] === "message")
      .map((c: any[]) => c[1]);
    for (const h of handlers) await h(data);

    expect(ws.messages.some((m: any) => m.type === "pong")).toBe(true);
  });

  it("should return error for invalid JSON", async () => {
    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    const data = Buffer.from("not json{{{");
    const handlers = ws.on.mock.calls
      .filter((c: any[]) => c[0] === "message")
      .map((c: any[]) => c[1]);
    for (const h of handlers) await h(data);

    expect(ws.messages.some((m: any) => m.type === "error" && m.content === "Invalid JSON")).toBe(true);
  });

  it("should list all tasks via session tasks query", async () => {
    setupFetchForMultipleTurns(["R1", "R2", "R3"]);

    const ws = createMockWs();
    handleWebSocket(ws as any, {} as any);

    await sendChat(ws, { message: "Turn 1" });
    const sessionId = ws.messages.find((m: any) => m.type === "session_created").session_id;
    await sendChat(ws, { session_id: sessionId, message: "Turn 2" });
    await sendChat(ws, { session_id: sessionId, message: "Turn 3" });

    const tasks = listTasksBySession(sessionId);
    expect(tasks.length).toBe(3);
    expect(tasks.map((t) => t.message)).toEqual(["Turn 1", "Turn 2", "Turn 3"]);
  });
});
