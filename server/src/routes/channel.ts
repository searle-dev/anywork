import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getChannel } from "../channel/registry";
import { createTask } from "../db/tasks";
import { getDb } from "../db/schema";
import { dispatch } from "../task/dispatcher";

const router = Router();

// Unified webhook entry point for all channels
router.post("/:type/webhook", async (req, res) => {
  const channel = getChannel(req.params.type);
  if (!channel) {
    return res.status(404).json({ error: `Unknown channel: ${req.params.type}` });
  }

  // 1. Verify request
  const incomingReq = {
    headers: req.headers as Record<string, string>,
    body: req.body,
    query: req.query as Record<string, string>,
  };

  if (!await channel.verify(incomingReq)) {
    return res.status(401).json({ error: "Verification failed" });
  }

  // 2. Convert to TaskRequest
  const taskReq = await channel.toTaskRequest(incomingReq);
  if (!taskReq) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // 3. Merge channel defaults
  const mergedSkills = [...channel.defaults.skills, ...taskReq.skills];
  const mergedMcpServers = [...channel.defaults.mcpServers, ...taskReq.mcpServers];

  // 4. Ensure session exists
  const db = getDb();
  const existingSession = db.prepare("SELECT id FROM sessions WHERE id = ?").get(taskReq.sessionId);
  if (!existingSession) {
    db.prepare("INSERT INTO sessions (id, channel_type) VALUES (?, ?)").run(
      taskReq.sessionId,
      taskReq.channelType,
    );
  }

  // 5. Create Task
  const task = createTask({
    id: uuid(),
    sessionId: taskReq.sessionId,
    channelType: taskReq.channelType,
    channelMeta: taskReq.channelMeta,
    message: taskReq.message,
    skills: mergedSkills,
    mcpServers: mergedMcpServers,
    pushNotification: taskReq.pushNotification,
  });

  // 6. Dispatch async (don't block webhook response)
  dispatch(task, channel).catch((err) => {
    console.error(`[Channel] Dispatch error for task ${task.id}:`, err);
  });

  // 7. Return 202 Accepted
  res.status(202).json({ taskId: task.id });
});

export default router;
