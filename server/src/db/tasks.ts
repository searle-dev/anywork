import { getDb } from "./schema";

export interface TaskRecord {
  id: string;
  session_id: string;
  channel_type: string;
  channel_meta: string;
  status: "pending" | "running" | "input_required" | "completed" | "failed" | "canceled";
  message: string;
  skills: string;
  mcp_servers: string;
  result: string | null;
  structured_output: string | null;
  error: string | null;
  cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  worker_id: string | null;
  push_notification: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TaskLogEntry {
  task_id: string;
  seq: number;
  type: string;
  content: string;
  metadata: string;
  timestamp: number;
}

// ── Task CRUD ──────────────────────────────────────────────

export function createTask(task: {
  id: string;
  sessionId: string;
  channelType: string;
  channelMeta?: object;
  message: string;
  skills?: string[];
  mcpServers?: object[];
  pushNotification?: object;
}): TaskRecord {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO tasks (id, session_id, channel_type, channel_meta, message, skills, mcp_servers, push_notification, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id,
    task.sessionId,
    task.channelType,
    JSON.stringify(task.channelMeta ?? {}),
    task.message,
    JSON.stringify(task.skills ?? []),
    JSON.stringify(task.mcpServers ?? []),
    task.pushNotification ? JSON.stringify(task.pushNotification) : null,
    now,
  );

  return getTask(task.id)!;
}

export function getTask(taskId: string): TaskRecord | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as TaskRecord | undefined;
}

export function updateTask(
  taskId: string,
  updates: Partial<{
    status: string;
    result: string;
    structured_output: string;
    error: string;
    cost_usd: number;
    num_turns: number;
    duration_ms: number;
    worker_id: string;
    started_at: number;
    finished_at: number;
  }>
): void {
  const db = getDb();
  const setClauses: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
  }

  if (setClauses.length === 0) return;
  values.push(taskId);

  db.prepare(`UPDATE tasks SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
}

export function listTasksBySession(sessionId: string): TaskRecord[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as TaskRecord[];
}

// ── Task Logs ──────────────────────────────────────────────

export function insertTaskLog(entry: {
  taskId: string;
  seq: number;
  type: string;
  content: string;
  metadata?: object;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO task_logs (task_id, seq, type, content, metadata, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    entry.taskId,
    entry.seq,
    entry.type,
    entry.content,
    JSON.stringify(entry.metadata ?? {}),
    Math.floor(Date.now() / 1000),
  );
}

export function getTaskLogs(
  taskId: string,
  afterSeq: number = 0,
  limit: number = 100,
): TaskLogEntry[] {
  const db = getDb();
  return db
    .prepare("SELECT * FROM task_logs WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .all(taskId, afterSeq, limit) as TaskLogEntry[];
}

export function getTaskLogCount(taskId: string): number {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) as count FROM task_logs WHERE task_id = ?")
    .get(taskId) as { count: number };
  return row.count;
}
