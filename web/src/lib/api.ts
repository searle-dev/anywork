// API base URL - points to the server from the browser's perspective
// In Docker: browser connects to localhost:3001 (host-mapped port)
// In dev: same
export const API_URL =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export const WS_URL =
  process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001/ws";

export async function fetchSessions() {
  const res = await fetch(`${API_URL}/api/sessions`);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return res.json();
}

export async function fetchSessionMessages(sessionId: string): Promise<{ messages: Array<{ role: string; content: string; timestamp: string; tool_calls?: Array<{ name: string; status: string }> }> }> {
  const res = await fetch(`${API_URL}/api/sessions/${sessionId}/messages`);
  if (!res.ok) return { messages: [] };
  return res.json();
}

export async function getWorkspaceFile(name: "soul" | "agents"): Promise<string> {
  const res = await fetch(`${API_URL}/api/workspace/${name}`);
  if (!res.ok) return "";
  const data = await res.json();
  return data.content ?? "";
}

export async function deleteSession(sessionId: string): Promise<void> {
  await fetch(`${API_URL}/api/sessions/${sessionId}`, { method: "DELETE" });
}

export async function updateWorkspaceFile(name: "soul" | "agents", content: string): Promise<void> {
  await fetch(`${API_URL}/api/workspace/${name}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
}
