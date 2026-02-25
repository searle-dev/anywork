import { Router } from "express";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { getContainerDriver } from "../scheduler/container";

const router = Router();

// List sessions for a user
router.get("/", (req, res) => {
  const userId = (req as any).userId || "default";
  const db = getDb();

  const sessions = db
    .prepare(
      "SELECT id, title, created_at, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC"
    )
    .all(userId);

  res.json({ sessions });
});

// Create a new session
router.post("/", (req, res) => {
  const userId = (req as any).userId || "default";
  const { title } = req.body || {};
  const id = uuid();
  const db = getDb();

  db.prepare(
    "INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)"
  ).run(id, userId, title || "New Chat");

  res.status(201).json({
    id,
    user_id: userId,
    title: title || "New Chat",
  });
});

// Get a specific session
router.get("/:id", (req, res) => {
  const db = getDb();
  const session = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  res.json(session);
});

// Update session title
router.patch("/:id", (req, res) => {
  const { title } = req.body;
  const db = getDb();

  db.prepare(
    "UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(title, req.params.id);

  res.json({ success: true });
});

// Get message history for a session (proxied from worker)
router.get("/:id/messages", async (req, res) => {
  try {
    const driver = getContainerDriver();
    const endpoint = await driver.getWorkerEndpoint("default");
    const response = await fetch(`${endpoint.url}/sessions/${req.params.id}`);
    if (!response.ok) {
      return res.status(response.status).json({ messages: [] });
    }
    const data = await response.json() as { messages: unknown[] };
    res.json({ messages: data.messages || [] });
  } catch (err: any) {
    res.status(500).json({ messages: [], error: err.message });
  }
});

// Delete a session
router.delete("/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

export default router;
