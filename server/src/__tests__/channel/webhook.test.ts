import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import type { Channel, IncomingRequest, TaskRequest } from "../../channel/types";
import { registerChannel, getChannel } from "../../channel/registry";
import { getDb } from "../../db/schema";
import { getTask } from "../../db/tasks";

// We need to mock dispatch so it doesn't actually try to talk to a worker
vi.mock("../../task/dispatcher", () => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
}));

import { dispatch } from "../../task/dispatcher";
import channelRouter from "../../routes/channel";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/channel", channelRouter);
  return app;
}

function createMockChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    type: "test-hook",
    defaults: { skills: ["default-skill"], mcpServers: [] },
    verify: vi.fn().mockResolvedValue(true),
    toTaskRequest: vi.fn().mockResolvedValue({
      sessionId: "webhook-session-1",
      channelType: "test-hook",
      channelMeta: { repo: "my-repo" },
      message: "webhook event",
      skills: ["extra-skill"],
      mcpServers: [],
    } satisfies TaskRequest),
    ...overrides,
  };
}

describe("Webhook Channel Route", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("should return 404 for unknown channel type", async () => {
    const res = await request(app)
      .post("/api/channel/unknown/webhook")
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/Unknown channel/);
  });

  it("should return 401 when verify fails", async () => {
    const ch = createMockChannel({ verify: vi.fn().mockResolvedValue(false) });
    registerChannel(ch);

    const res = await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({ data: "payload" });
    expect(res.status).toBe(401);
    expect(ch.verify).toHaveBeenCalled();
  });

  it("should return 200 + skipped when toTaskRequest returns null", async () => {
    const ch = createMockChannel({ toTaskRequest: vi.fn().mockResolvedValue(null) });
    registerChannel(ch);

    const res = await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({ data: "payload" });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(true);
  });

  it("should return 202 + taskId on successful webhook", async () => {
    const ch = createMockChannel();
    registerChannel(ch);

    const res = await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({ data: "payload" });

    expect(res.status).toBe(202);
    expect(res.body.taskId).toBeDefined();
    expect(typeof res.body.taskId).toBe("string");
  });

  it("should auto-create session in database", async () => {
    const ch = createMockChannel();
    registerChannel(ch);

    await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({});

    const db = getDb();
    const session = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get("webhook-session-1") as any;
    expect(session).toBeDefined();
    expect(session.channel_type).toBe("test-hook");
  });

  it("should create task with correct fields in DB", async () => {
    const ch = createMockChannel();
    registerChannel(ch);

    const res = await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({});

    const task = getTask(res.body.taskId);
    expect(task).toBeDefined();
    expect(task!.session_id).toBe("webhook-session-1");
    expect(task!.channel_type).toBe("test-hook");
    expect(task!.message).toBe("webhook event");
    expect(JSON.parse(task!.channel_meta)).toEqual({ repo: "my-repo" });
    // Skills should be merged: channel defaults + task request
    expect(JSON.parse(task!.skills)).toEqual(["default-skill", "extra-skill"]);
  });

  it("should call dispatch asynchronously", async () => {
    const ch = createMockChannel();
    registerChannel(ch);

    await request(app)
      .post("/api/channel/test-hook/webhook")
      .send({});

    // dispatch is called but we don't await its result in the route (fire-and-forget)
    expect(dispatch).toHaveBeenCalledOnce();
    const [task, channel] = (dispatch as any).mock.calls[0];
    expect(task.session_id).toBe("webhook-session-1");
    expect(channel.type).toBe("test-hook");
  });

  it("should not duplicate session on second webhook with same sessionId", async () => {
    const ch = createMockChannel();
    registerChannel(ch);

    await request(app).post("/api/channel/test-hook/webhook").send({});
    await request(app).post("/api/channel/test-hook/webhook").send({});

    const db = getDb();
    const sessions = db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .all("webhook-session-1");
    expect(sessions.length).toBe(1);
  });
});
