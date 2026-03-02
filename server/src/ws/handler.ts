/**
 * WebSocket handler - bridges browser WebSocket to the Channel → Task → Worker pipeline.
 *
 * Flow:
 *   Browser --WebSocket--> Server (Channel → Dispatcher → Worker)
 *          <--WebSocket-- (real-time SSE relay)
 */

import WebSocket from "ws";
import { IncomingMessage } from "http";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/schema";
import { createTask } from "../db/tasks";
import { webChatChannel } from "../channel/webchat";
import { dispatch } from "../task/dispatcher";
import { generateTitle } from "../lib/titleGen";

interface ClientMessage {
  type: "chat" | "ping";
  session_id?: string;
  message?: string;
  skills?: string[];
  mcp_servers?: Array<{
    name: string;
    transport: "stdio" | "sse";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
  }>;
}

interface ServerMessage {
  type: string;
  content?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export function handleWebSocket(ws: WebSocket, _req: IncomingMessage) {
  console.log("[WS] Client connected");

  ws.on("message", async (data) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      sendMessage(ws, { type: "error", content: "Invalid JSON" });
      return;
    }

    if (msg.type === "ping") {
      sendMessage(ws, { type: "pong" });
      return;
    }

    if (msg.type === "chat") {
      await handleChat(ws, msg);
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
}

async function handleChat(ws: WebSocket, msg: ClientMessage) {
  const db = getDb();

  // Auto-create session if not provided
  const isNewSession = !msg.session_id;
  let sessionId = msg.session_id;
  if (!sessionId) {
    sessionId = uuid();
    db.prepare("INSERT INTO sessions (id, channel_type) VALUES (?, ?)").run(
      sessionId,
      "webchat",
    );
    sendMessage(ws, { type: "session_created", session_id: sessionId });
  }

  if (!msg.message) {
    sendMessage(ws, { type: "error", content: "Empty message" });
    return;
  }

  // Generate title in parallel (fire-and-forget)
  if (isNewSession) {
    generateTitle(msg.message)
      .then((title) => {
        if (!title) return;
        db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId);
        sendMessage(ws, { type: "session_title", content: title, session_id: sessionId });
      })
      .catch(() => {});
  }

  // Build TaskRequest via WebChat channel
  const taskReq = await webChatChannel.toTaskRequest({
    headers: {},
    body: msg as any,
    query: {},
  });

  if (!taskReq) {
    sendMessage(ws, { type: "error", content: "Invalid message" });
    return;
  }

  // Fill in sessionId (webchat channel doesn't know about auto-creation)
  taskReq.sessionId = sessionId;

  // Merge channel defaults
  const mergedSkills = [...webChatChannel.defaults.skills, ...taskReq.skills];
  const mergedMcpServers = [...webChatChannel.defaults.mcpServers, ...taskReq.mcpServers];

  // Create Task
  const task = createTask({
    id: uuid(),
    sessionId,
    channelType: "webchat",
    message: msg.message,
    skills: mergedSkills,
    mcpServers: mergedMcpServers,
  });

  // Dispatch (streams results back through WebSocket)
  await dispatch(task, webChatChannel, ws);

  // Update session last_active
  db.prepare("UPDATE sessions SET last_active = unixepoch() WHERE id = ?").run(sessionId);
}

function sendMessage(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
