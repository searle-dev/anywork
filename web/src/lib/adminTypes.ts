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

export interface WorkerInfo {
  sessionId: string;
  containerId: string;
  url: string;
  healthy: boolean | null;
}

export interface WorkersOverview {
  driver: string;
  workerImage: string;
  staticWorkerUrl?: string;
  k8s?: { namespace: string; workspaceStorage: string; idleTtlSeconds: number };
  workers: WorkerInfo[];
}

export interface TaskLog {
  seq: number;
  type: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}
