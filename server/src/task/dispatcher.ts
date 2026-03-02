/**
 * Task dispatcher.
 *
 * Orchestrates: resolve skills → get worker → /prepare → /chat → handle stream → deliver.
 */

import type { WebSocket } from "ws";
import { getContainerDriver } from "../scheduler/container";
import { updateTask, insertTaskLog, getTask } from "../db/tasks";
import type { Channel, TaskRequest, MCPServerConfig } from "../channel/types";
import type { TaskRecord } from "../db/tasks";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Dispatch a task: acquire a worker, prepare skills/MCP, stream /chat, handle results.
 */
export async function dispatch(
  task: TaskRecord,
  channel: Channel,
  ws?: WebSocket,
): Promise<void> {
  try {
    const driver = getContainerDriver();

    // 1. Get or create Worker
    const endpoint = await driver.getWorkerEndpoint(task.session_id);
    updateTask(task.id, {
      status: "running",
      worker_id: endpoint.containerId,
      started_at: now(),
    });

    // 2. Prepare skills + MCP on Worker
    const skills: string[] = JSON.parse(task.skills || "[]");
    const mcpServers: MCPServerConfig[] = JSON.parse(task.mcp_servers || "[]");

    if (skills.length > 0 || mcpServers.length > 0) {
      const prepareRes = await fetch(`${endpoint.url}/prepare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: task.id,
          skills,
          mcp_servers: mcpServers,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!prepareRes.ok) {
        throw new Error(`Worker /prepare failed: ${prepareRes.status} ${await prepareRes.text()}`);
      }
    }

    // 3. POST /chat and consume SSE stream
    const chatRes = await fetch(`${endpoint.url}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_id: task.session_id,
        message: task.message,
      }),
    });

    if (!chatRes.ok) {
      throw new Error(`Worker /chat failed: ${chatRes.status} ${await chatRes.text()}`);
    }

    // 4. Handle SSE stream
    await handleWorkerStream(task.id, chatRes, ws);

    // 5. Deliver result for oneshot channels
    const finished = getTask(task.id);
    if (finished && channel.deliver && finished.status === "completed") {
      const channelMeta = JSON.parse(finished.channel_meta || "{}");
      await channel.deliver({
        status: finished.status,
        result: finished.result,
        channelMeta,
      });
    }

    // 6. Push notification
    if (finished?.push_notification) {
      const config = JSON.parse(finished.push_notification);
      if (config.webhookUrl) {
        await sendPushNotification(config, finished);
      }
    }
  } catch (err: any) {
    console.error(`[Dispatcher] Task ${task.id} failed:`, err.message);
    updateTask(task.id, {
      status: "failed",
      error: err.message,
      finished_at: now(),
    });

    // Notify WebSocket client of error
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: "error",
        content: err.message,
        session_id: task.session_id,
      }));
      ws.send(JSON.stringify({
        type: "done",
        session_id: task.session_id,
      }));
    }
  }
}

/**
 * Consume Worker SSE stream, write task_logs, optionally push to WebSocket.
 */
async function handleWorkerStream(
  taskId: string,
  response: Response,
  ws?: WebSocket,
): Promise<void> {
  const body = response.body;
  if (!body) {
    updateTask(taskId, { status: "completed", finished_at: now() });
    return;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seq = 0;
  let buffer = "";
  let lastResult = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const dataStr = line.slice(5).trim();
          if (!eventType || !dataStr) continue;

          let content = "";
          let metadata = {};
          try {
            const parsed = JSON.parse(dataStr);
            content = parsed.content ?? dataStr;
            metadata = parsed.metadata ?? {};
          } catch {
            content = dataStr;
          }

          // Write to task_logs
          insertTaskLog({ taskId, seq: seq++, type: eventType, content, metadata });

          // Forward to WebSocket (interactive mode)
          if (ws && ws.readyState === ws.OPEN) {
            const task = getTask(taskId);
            ws.send(JSON.stringify({
              type: eventType,
              content,
              metadata,
              session_id: task?.session_id,
            }));
          }

          // Track last text for result
          if (eventType === "text") {
            lastResult += content;
          }

          // Update task status on terminal events
          if (eventType === "done") {
            updateTask(taskId, {
              status: "completed",
              result: lastResult || null,
              finished_at: now(),
            });
          } else if (eventType === "error") {
            updateTask(taskId, {
              status: "failed",
              error: content,
              finished_at: now(),
            });
          }

          eventType = "";
        }
      }
    }

    // If stream ended without explicit done event, mark as completed
    const task = getTask(taskId);
    if (task && task.status === "running") {
      updateTask(taskId, {
        status: "completed",
        result: lastResult || null,
        finished_at: now(),
      });
    }
  } finally {
    reader.releaseLock();
  }
}

async function sendPushNotification(
  config: { webhookUrl: string; authHeader?: string },
  task: TaskRecord,
): Promise<void> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.authHeader) {
      headers["Authorization"] = config.authHeader;
    }
    await fetch(config.webhookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskId: task.id,
        sessionId: task.session_id,
        status: task.status,
        result: task.result,
        error: task.error,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    console.error(`[Dispatcher] Push notification failed for task ${task.id}:`, err.message);
  }
}
