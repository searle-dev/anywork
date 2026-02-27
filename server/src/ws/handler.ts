/**
 * WebSocket handler - bridges browser WebSocket connections to worker SSE streams.
 *
 * Flow:
 *   Browser --WebSocket--> Server --HTTP/SSE--> Worker(nanobot)
 *                                   <--SSE----
 *          <--WebSocket--
 */

import WebSocket from "ws";
import { IncomingMessage } from "http";
import { v4 as uuid } from "uuid";
import { getContainerDriver } from "../scheduler/container";
import { MCPServerConfig } from "../scheduler/drivers/interface";
import { getDb } from "../db/schema";
import { generateTitle } from "../lib/titleGen";

interface ClientMessage {
  type: "chat" | "ping";
  session_id?: string;
  message?: string;
  /**
   * Skills to activate for this session (first message only; ignored for
   * subsequent messages once the worker pod is already running).
   * Example: ["code-review", "data-analysis"]
   */
  skills?: string[];
  /**
   * MCP servers to connect on worker startup (first message only).
   * Example: [{"name":"github","transport":"stdio","command":"npx","args":["-y","@mcp/github"]}]
   */
  mcp_servers?: MCPServerConfig[];
  /**
   * Execution engine override for this session.
   * "nanobot" (default) or "claudecode".
   */
  engine?: "nanobot" | "claudecode";
}

interface ServerMessage {
  type: "text" | "tool_call" | "tool_result" | "error" | "done" | "pong" | "session_created" | "session_title";
  content?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}

export function handleWebSocket(ws: WebSocket, req: IncomingMessage) {
  const userId = "default"; // TODO: extract from JWT in req.url params
  console.log(`[WS] Client connected (user: ${userId})`);

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
      await handleChat(ws, userId, msg);
    }
  });

  ws.on("close", () => {
    console.log(`[WS] Client disconnected (user: ${userId})`);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error:`, err.message);
  });
}

async function handleChat(
  ws: WebSocket,
  userId: string,
  msg: ClientMessage
) {
  // Auto-create session if not provided
  const isNewSession = !msg.session_id;
  let sessionId = msg.session_id;
  if (!sessionId) {
    sessionId = uuid();
    const db = getDb();
    db.prepare(
      "INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)"
    ).run(sessionId, userId, "New Chat");
    sendMessage(ws, { type: "session_created", session_id: sessionId });
  }

  if (!msg.message) {
    sendMessage(ws, { type: "error", content: "Empty message" });
    return;
  }

  // Generate title immediately (parallel to agent, no waiting)
  if (isNewSession && msg.message) {
    generateTitle(msg.message).then((title) => {
      if (!title) return;
      getDb().prepare("UPDATE sessions SET title = ? WHERE id = ?").run(title, sessionId);
      sendMessage(ws, { type: "session_title", content: title, session_id: sessionId });
    }).catch(() => {});
  }

  try {
    // Get (or create) worker endpoint.
    // For the K8s driver this creates a per-session pod with the requested
    // skills/MCPs baked in as environment variables.
    const driver = getContainerDriver();
    const endpoint = await driver.getWorkerEndpoint(userId, {
      sessionId,
      skills: msg.skills,
      mcpServers: msg.mcp_servers,
      engine: msg.engine,
    });

    // POST to worker's /chat endpoint and stream SSE back
    const response = await fetch(`${endpoint.url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: sessionId,
        message: msg.message,
        user_id: userId,
      }),
    });

    if (!response.ok) {
      sendMessage(ws, {
        type: "error",
        content: `Worker error: ${response.status} ${response.statusText}`,
      });
      return;
    }

    // Parse SSE stream from worker and forward to WebSocket
    const reader = response.body?.getReader();
    if (!reader) {
      sendMessage(ws, { type: "error", content: "No response body" });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Parse SSE events from buffer
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      let eventType = "";
      let eventData = "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          eventData = line.slice(6);
        } else if (line.trim() === "" && eventType && eventData) {
          // Complete SSE event - handle session_title specially, forward others
          try {
            const parsed = JSON.parse(eventData);
            sendMessage(ws, {
              type: eventType as ServerMessage["type"],
              content: parsed.content,
              session_id: sessionId,
              metadata: parsed.metadata,
            });
          } catch {
            // Forward raw data
            sendMessage(ws, {
              type: eventType as ServerMessage["type"],
              content: eventData,
              session_id: sessionId,
            });
          }
          eventType = "";
          eventData = "";
        }
      }
    }

    // Update session timestamp
    const db = getDb();
    db.prepare(
      "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
    ).run(sessionId);

  } catch (err: any) {
    console.error(`[WS] Chat error:`, err);
    sendMessage(ws, {
      type: "error",
      content: `Server error: ${err.message}`,
    });
  }
}

function sendMessage(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}
