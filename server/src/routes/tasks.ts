import { Router } from "express";
import { getTask, getTaskLogs, getTaskLogCount, updateTask } from "../db/tasks";

const router = Router();

// Get task status and result
router.get("/:taskId", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  res.json({
    id: task.id,
    sessionId: task.session_id,
    channelType: task.channel_type,
    status: task.status,
    message: task.message,
    result: task.result,
    structuredOutput: task.structured_output ? JSON.parse(task.structured_output) : null,
    error: task.error,
    costUsd: task.cost_usd,
    numTurns: task.num_turns,
    durationMs: task.duration_ms,
    createdAt: task.created_at,
    startedAt: task.started_at,
    finishedAt: task.finished_at,
  });
});

// Get task execution logs (incremental pull)
router.get("/:taskId/logs", (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  const after = parseInt(req.query.after as string) || 0;
  const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);

  const logs = getTaskLogs(task.id, after, limit);
  const total = getTaskLogCount(task.id);

  res.json({
    logs: logs.map((l) => ({
      seq: l.seq,
      type: l.type,
      content: l.content,
      metadata: JSON.parse(l.metadata || "{}"),
      timestamp: l.timestamp,
    })),
    hasMore: logs.length > 0 ? logs[logs.length - 1].seq < total : false,
  });
});

// Cancel a running task
router.post("/:taskId/cancel", async (req, res) => {
  const task = getTask(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  if (task.status !== "running" && task.status !== "pending" && task.status !== "input_required") {
    return res.status(409).json({ error: `Cannot cancel task in status: ${task.status}` });
  }

  // If we have a worker, try to cancel on it
  if (task.worker_id) {
    try {
      const { getContainerDriver } = await import("../scheduler/container");
      const driver = getContainerDriver();
      const endpoint = await driver.getWorkerEndpoint(task.session_id);
      await fetch(`${endpoint.url}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: task.session_id }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Best effort — worker may be gone
    }
  }

  updateTask(task.id, {
    status: "canceled",
    finished_at: Math.floor(Date.now() / 1000),
  });

  res.json({ success: true });
});

export default router;
