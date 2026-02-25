export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  name: string;
  status: "running" | "done" | "error";
  input?: string;
  output?: string;
}

export interface ServerEvent {
  type: "text" | "tool_call" | "tool_result" | "error" | "done" | "pong" | "session_created" | "session_title";
  content?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export interface FileEntry {
  name: string;
  type: "file" | "dir";
  size: number;
  modified: string;
}
