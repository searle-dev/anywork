import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../../db/schema";
import {
  createTask,
  getTask,
  updateTask,
  listTasksBySession,
  insertTaskLog,
  getTaskLogs,
  getTaskLogCount,
} from "../../db/tasks";

function ensureSession(id: string) {
  const db = getDb();
  const exists = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
  if (!exists) {
    db.prepare("INSERT INTO sessions (id, channel_type) VALUES (?, ?)").run(id, "test");
  }
}

describe("Task CRUD", () => {
  beforeAll(() => {
    ensureSession("crud-session");
    ensureSession("list-session");
  });

  it("should create a task and return full TaskRecord", () => {
    const task = createTask({
      id: "task-create-1",
      sessionId: "crud-session",
      channelType: "webchat",
      message: "Hello world",
      skills: ["code-review"],
      mcpServers: [{ name: "github", transport: "stdio" }],
    });

    expect(task.id).toBe("task-create-1");
    expect(task.session_id).toBe("crud-session");
    expect(task.channel_type).toBe("webchat");
    expect(task.status).toBe("pending");
    expect(task.message).toBe("Hello world");
    expect(JSON.parse(task.skills)).toEqual(["code-review"]);
    expect(JSON.parse(task.mcp_servers)).toEqual([{ name: "github", transport: "stdio" }]);
    expect(task.created_at).toBeGreaterThan(0);
    expect(task.result).toBeNull();
    expect(task.error).toBeNull();
  });

  it("should store channelMeta as JSON", () => {
    const task = createTask({
      id: "task-meta-1",
      sessionId: "crud-session",
      channelType: "github",
      channelMeta: { repo: "my-repo", pr: 42 },
      message: "PR opened",
    });

    expect(JSON.parse(task.channel_meta)).toEqual({ repo: "my-repo", pr: 42 });
  });

  it("should store pushNotification as JSON", () => {
    const task = createTask({
      id: "task-push-1",
      sessionId: "crud-session",
      channelType: "test",
      message: "webhook task",
      pushNotification: { webhookUrl: "https://example.com/cb" },
    });

    expect(task.push_notification).not.toBeNull();
    expect(JSON.parse(task.push_notification!)).toEqual({ webhookUrl: "https://example.com/cb" });
  });

  it("should get an existing task", () => {
    createTask({ id: "task-get-1", sessionId: "crud-session", channelType: "test", message: "hi" });
    const task = getTask("task-get-1");
    expect(task).toBeDefined();
    expect(task!.id).toBe("task-get-1");
  });

  it("should return undefined for non-existent task", () => {
    const task = getTask("nonexistent-task-id");
    expect(task).toBeUndefined();
  });

  it("should update task fields partially", () => {
    createTask({ id: "task-update-1", sessionId: "crud-session", channelType: "test", message: "update me" });

    updateTask("task-update-1", { status: "running", worker_id: "w-123", started_at: 1000 });
    let task = getTask("task-update-1")!;
    expect(task.status).toBe("running");
    expect(task.worker_id).toBe("w-123");
    expect(task.started_at).toBe(1000);

    updateTask("task-update-1", { status: "completed", result: "done", finished_at: 2000 });
    task = getTask("task-update-1")!;
    expect(task.status).toBe("completed");
    expect(task.result).toBe("done");
    expect(task.finished_at).toBe(2000);
  });

  it("should update cost, num_turns, duration_ms", () => {
    createTask({ id: "task-cost-1", sessionId: "crud-session", channelType: "test", message: "cost" });

    updateTask("task-cost-1", { cost_usd: 0.015, num_turns: 3, duration_ms: 5000 });
    const task = getTask("task-cost-1")!;
    expect(task.cost_usd).toBe(0.015);
    expect(task.num_turns).toBe(3);
    expect(task.duration_ms).toBe(5000);
  });

  it("should list tasks by session in order", () => {
    createTask({ id: "list-1", sessionId: "list-session", channelType: "test", message: "first" });
    createTask({ id: "list-2", sessionId: "list-session", channelType: "test", message: "second" });
    createTask({ id: "list-3", sessionId: "list-session", channelType: "test", message: "third" });

    const tasks = listTasksBySession("list-session");
    expect(tasks.length).toBe(3);
    expect(tasks.map((t) => t.id)).toEqual(["list-1", "list-2", "list-3"]);
  });

  it("should return empty array for session with no tasks", () => {
    const tasks = listTasksBySession("no-tasks-session");
    expect(tasks).toEqual([]);
  });

  describe("Task status transitions", () => {
    it("pending → running → completed", () => {
      createTask({ id: "flow-1", sessionId: "crud-session", channelType: "test", message: "flow" });
      expect(getTask("flow-1")!.status).toBe("pending");

      updateTask("flow-1", { status: "running", started_at: 100 });
      expect(getTask("flow-1")!.status).toBe("running");

      updateTask("flow-1", { status: "completed", result: "ok", finished_at: 200 });
      expect(getTask("flow-1")!.status).toBe("completed");
    });

    it("pending → running → failed", () => {
      createTask({ id: "flow-2", sessionId: "crud-session", channelType: "test", message: "fail" });
      updateTask("flow-2", { status: "running", started_at: 100 });
      updateTask("flow-2", { status: "failed", error: "crash", finished_at: 200 });

      const task = getTask("flow-2")!;
      expect(task.status).toBe("failed");
      expect(task.error).toBe("crash");
    });

    it("pending → running → canceled", () => {
      createTask({ id: "flow-3", sessionId: "crud-session", channelType: "test", message: "cancel" });
      updateTask("flow-3", { status: "running", started_at: 100 });
      updateTask("flow-3", { status: "canceled", finished_at: 200 });

      expect(getTask("flow-3")!.status).toBe("canceled");
    });
  });
});

describe("Task Logs", () => {
  beforeAll(() => {
    ensureSession("log-session");
  });

  it("should insert and retrieve task logs", () => {
    createTask({ id: "log-task-1", sessionId: "log-session", channelType: "test", message: "log" });

    insertTaskLog({ taskId: "log-task-1", seq: 0, type: "text", content: "Hello" });
    insertTaskLog({ taskId: "log-task-1", seq: 1, type: "tool_call", content: "search", metadata: { tool: "grep" } });
    insertTaskLog({ taskId: "log-task-1", seq: 2, type: "done", content: "" });

    const logs = getTaskLogs("log-task-1", -1);
    expect(logs.length).toBe(3);
    expect(logs[0].type).toBe("text");
    expect(logs[0].content).toBe("Hello");
    expect(logs[0].seq).toBe(0);
    expect(logs[1].type).toBe("tool_call");
    expect(JSON.parse(logs[1].metadata)).toEqual({ tool: "grep" });
    expect(logs[2].type).toBe("done");
  });

  it("should filter logs by afterSeq", () => {
    createTask({ id: "log-task-2", sessionId: "log-session", channelType: "test", message: "log2" });

    for (let i = 0; i < 5; i++) {
      insertTaskLog({ taskId: "log-task-2", seq: i, type: "text", content: `msg-${i}` });
    }

    const logsAfter2 = getTaskLogs("log-task-2", 2);
    expect(logsAfter2.length).toBe(2);
    expect(logsAfter2[0].seq).toBe(3);
    expect(logsAfter2[1].seq).toBe(4);
  });

  it("should limit number of returned logs", () => {
    createTask({ id: "log-task-3", sessionId: "log-session", channelType: "test", message: "log3" });

    for (let i = 0; i < 10; i++) {
      insertTaskLog({ taskId: "log-task-3", seq: i, type: "text", content: `msg-${i}` });
    }

    const limited = getTaskLogs("log-task-3", -1, 3);
    expect(limited.length).toBe(3);
    expect(limited[0].seq).toBe(0);
    expect(limited[2].seq).toBe(2);
  });

  it("should count task logs", () => {
    createTask({ id: "log-task-4", sessionId: "log-session", channelType: "test", message: "log4" });

    for (let i = 0; i < 7; i++) {
      insertTaskLog({ taskId: "log-task-4", seq: i, type: "text", content: `msg` });
    }

    expect(getTaskLogCount("log-task-4")).toBe(7);
  });

  it("should return 0 for task with no logs", () => {
    createTask({ id: "log-task-5", sessionId: "log-session", channelType: "test", message: "empty" });
    expect(getTaskLogCount("log-task-5")).toBe(0);
  });

  it("should return empty array for non-existent task logs", () => {
    const logs = getTaskLogs("nonexistent-task", -1);
    expect(logs).toEqual([]);
  });
});
