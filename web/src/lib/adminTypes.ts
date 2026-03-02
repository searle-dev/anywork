export interface AdminSession {
  id: string;
  channel_type: string;
  title: string;
  created_at: number;
  last_active: number;
  task_count: number;
  active_task_count: number;
}

export interface AdminTask {
  id: string;
  sessionId: string;
  channelType: string;
  status: "pending" | "running" | "input_required" | "completed" | "failed" | "canceled";
  message: string;
  result: string | null;
  error: string | null;
  costUsd: number | null;
  numTurns: number | null;
  durationMs: number | null;
  workerId: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface TaskLog {
  seq: number;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}
