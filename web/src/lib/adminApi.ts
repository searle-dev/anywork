import { API_URL } from "./api";
import type { AdminSession, AdminTask, TaskLog, WorkersOverview } from "./adminTypes";

export async function fetchAdminSessions(): Promise<AdminSession[]> {
  const res = await fetch(`${API_URL}/api/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  const data = await res.json();
  return data.sessions;
}

export async function fetchSessionTasks(sessionId: string): Promise<AdminTask[]> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/tasks`);
  if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);
  const data = await res.json();
  return data.tasks;
}

export async function fetchTaskDetail(taskId: string): Promise<AdminTask> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}`);
  if (!res.ok) throw new Error(`Failed to fetch task: ${res.status}`);
  return res.json();
}

export async function fetchTaskLogs(taskId: string, afterSeq: number = 0): Promise<{ logs: TaskLog[]; hasMore: boolean }> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}/logs?after=${afterSeq}`);
  if (!res.ok) throw new Error(`Failed to fetch logs: ${res.status}`);
  return res.json();
}

export async function cancelTask(taskId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/tasks/${taskId}/cancel`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to cancel task: ${res.status}`);
}

export async function fetchWorkers(): Promise<WorkersOverview> {
  const res = await fetch(`${API_URL}/api/admin/workers`);
  if (!res.ok) throw new Error(`Failed to fetch workers: ${res.status}`);
  return res.json();
}
