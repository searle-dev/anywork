import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { listTasksBySession } from "../db/tasks";
import { getContainerDriver } from "../scheduler/container";

const router = Router();

// List all sessions
router.get("/", (_req, res) => {
  const db = getDb();
  const sessions = db
    .prepare("SELECT id, channel_type, title, created_at, last_active FROM sessions ORDER BY last_active DESC")
    .all();
  res.json({ sessions });
});

// Create a new session
router.post("/", (req, res) => {
  const { title, channelType } = req.body || {};
  const id = uuid();
  const db = getDb();

  db.prepare("INSERT INTO sessions (id, channel_type, title) VALUES (?, ?, ?)").run(
    id,
    channelType || "webchat",
    title || "New Chat",
  );

  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
  res.status(201).json(session);
});

// Get a specific session
router.get("/:id", (req, res) => {
  const db = getDb();
  const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(session);
});

// Update session title
router.patch("/:id", (req, res) => {
  const { title } = req.body;
  const db = getDb();
  db.prepare("UPDATE sessions SET title = ?, last_active = unixepoch() WHERE id = ?").run(
    title,
    req.params.id,
  );
  res.json({ success: true });
});

// Delete a session
router.delete("/:id", (req, res) => {
  const db = getDb();
  // Delete associated task logs and tasks first
  const tasks = listTasksBySession(req.params.id);
  for (const task of tasks) {
    db.prepare("DELETE FROM task_logs WHERE task_id = ?").run(task.id);
  }
  db.prepare("DELETE FROM tasks WHERE session_id = ?").run(req.params.id);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Get message history for a session (proxied from worker — backward compat)
router.get("/:id/messages", async (req, res) => {
  try {
    const driver = getContainerDriver();
    const endpoint = await driver.getWorkerEndpoint(req.params.id);
    const response = await fetch(`${endpoint.url}/sessions/${req.params.id}`);
    if (!response.ok) {
      return res.status(response.status).json({ messages: [] });
    }
    const data = (await response.json()) as { messages: unknown[] };
    res.json({ messages: data.messages || [] });
  } catch {
    // Worker not available — return empty
    res.json({ messages: [] });
  }
});

export default router;
