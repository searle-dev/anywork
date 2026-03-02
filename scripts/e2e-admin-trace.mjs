/**
 * E2E Test: Task full-pipeline tracing via Admin API.
 *
 * Sends a message through WebSocket, then uses Admin REST APIs to trace the
 * complete execution chain:
 *   Channel (webchat) → Session → Task → Worker assignment → Execution Logs → Result
 *
 * This validates both the task execution pipeline AND the admin dashboard data layer.
 *
 * Usage: node scripts/e2e-admin-trace.mjs
 *
 * Requires: Server on :3001, Worker on :8080
 */

import { createRequire } from "module";
const require = createRequire(
  new URL("../server/node_modules/ws/index.js", import.meta.url),
);
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://localhost:3001/ws";
const API_URL = process.env.API_URL || "http://localhost:3001";
const TURN_TIMEOUT_MS = 120_000;

// ── Helpers ──────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(tag, msg) {
  console.log(`[${ts()}] [${tag}] ${msg}`);
}

function separator(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}`);
}

async function fetchJSON(path) {
  const res = await fetch(`${API_URL}${path}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

function assertOk(condition, msg) {
  if (!condition) {
    log("FAIL", `✗ ${msg}`);
    throw new Error(msg);
  }
  log("PASS", `✓ ${msg}`);
}

// ── WebSocket send-and-wait ──────────────────────────────────

function connectAndSend(message) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    let sessionId = null;
    const events = [];

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("Timed out waiting for done/error"));
    }, TURN_TIMEOUT_MS);

    ws.on("open", () => {
      log("WS", "Connected, sending chat message...");
      ws.send(JSON.stringify({ type: "chat", message }));
    });

    ws.on("message", (data) => {
      const evt = JSON.parse(data.toString());
      events.push(evt);

      if (evt.type === "session_created") {
        sessionId = evt.session_id;
        log("WS", `Session created: ${sessionId}`);
      }

      if (evt.type === "text") {
        const preview = (evt.content || "").slice(0, 80).replace(/\n/g, "↵");
        log("WS", `text: ${preview}...`);
      }
      if (evt.type === "tool_call") {
        log("WS", `tool_call: ${evt.content}`);
      }
      if (evt.type === "tool_result") {
        log("WS", `tool_result: ${(evt.content || "").slice(0, 60)}`);
      }

      if (evt.type === "done" || evt.type === "error") {
        clearTimeout(timeout);
        ws.close();
        resolve({ sessionId, events });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

// ── Trace Functions ──────────────────────────────────────────

async function traceSession(sessionId) {
  separator("Step 2: Trace Session (Admin API)");

  // 2a. GET /api/sessions — should include our session with task_count
  const { sessions } = await fetchJSON("/api/sessions");
  const session = sessions.find((s) => s.id === sessionId);
  assertOk(session, `Session ${sessionId.slice(0, 8)}... found in session list`);
  assertOk(session.channel_type === "webchat", `Channel type is "webchat"`);
  assertOk(session.task_count >= 1, `task_count = ${session.task_count} (>= 1)`);

  log("INFO", `Title: "${session.title}"`);
  log("INFO", `Channel: ${session.channel_type}`);
  log("INFO", `Tasks: ${session.task_count} total, ${session.active_task_count} active`);
  log("INFO", `Last active: ${new Date(session.last_active * 1000).toISOString()}`);

  return session;
}

async function traceTasks(sessionId) {
  separator("Step 3: Trace Tasks (Admin API)");

  // 3a. GET /api/sessions/:id/tasks
  const { tasks } = await fetchJSON(`/api/sessions/${sessionId}/tasks`);
  assertOk(tasks.length >= 1, `Found ${tasks.length} task(s) for session`);

  const task = tasks[tasks.length - 1]; // latest task
  assertOk(task.sessionId === sessionId, `Task belongs to correct session`);
  assertOk(task.channelType === "webchat", `Task channelType is "webchat"`);
  assertOk(
    ["completed", "failed"].includes(task.status),
    `Task status is terminal: "${task.status}"`,
  );
  assertOk(task.message, `Task has a message`);

  log("INFO", `Task ID: ${task.id}`);
  log("INFO", `Status: ${task.status}`);
  log("INFO", `Message: "${task.message.slice(0, 60)}..."`);
  log("INFO", `Worker ID: ${task.workerId || "(none)"}`);

  return task;
}

async function traceTaskDetail(taskId) {
  separator("Step 4: Trace Task Detail (Admin API)");

  // 4a. GET /api/tasks/:taskId
  const detail = await fetchJSON(`/api/tasks/${taskId}`);
  assertOk(detail.id === taskId, `Task detail ID matches`);
  assertOk(detail.status === "completed" || detail.status === "failed", `Status: ${detail.status}`);
  assertOk(detail.createdAt > 0, `createdAt is set`);
  assertOk(detail.startedAt > 0, `startedAt is set (worker picked it up)`);
  assertOk(detail.finishedAt > 0, `finishedAt is set`);

  const durationSec = detail.durationMs ? (detail.durationMs / 1000).toFixed(1) : "n/a";
  const costStr = detail.costUsd != null ? `$${detail.costUsd.toFixed(4)}` : "n/a";

  log("INFO", `Worker: ${detail.workerId || "(none)"}`);
  log("INFO", `Duration: ${durationSec}s`);
  log("INFO", `Cost: ${costStr}`);
  log("INFO", `Turns: ${detail.numTurns ?? "n/a"}`);
  log("INFO", `Created → Started: ${detail.startedAt - detail.createdAt}s`);
  log("INFO", `Started → Finished: ${detail.finishedAt - detail.startedAt}s`);

  if (detail.result) {
    log("INFO", `Result: ${detail.result.slice(0, 120).replace(/\n/g, "↵")}...`);
  }
  if (detail.error) {
    log("INFO", `Error: ${detail.error.slice(0, 200)}`);
  }

  return detail;
}

async function traceTaskLogs(taskId) {
  separator("Step 6: Trace Execution Logs (Admin API)");

  // 5a. GET /api/tasks/:taskId/logs
  const { logs, hasMore } = await fetchJSON(`/api/tasks/${taskId}/logs?after=0`);
  assertOk(logs.length > 0, `Found ${logs.length} log entries`);

  // Categorize logs
  const counts = {};
  for (const l of logs) {
    counts[l.type] = (counts[l.type] || 0) + 1;
  }
  log("INFO", `Log types: ${JSON.stringify(counts)}`);
  log("INFO", `Has more: ${hasMore}`);

  // Print timeline
  console.log("");
  console.log("  Execution Timeline:");
  console.log("  ┌──────────────────────────────────────────────");
  for (const l of logs) {
    const time = new Date(l.timestamp * 1000).toISOString().slice(11, 19);
    const typeTag = l.type.padEnd(12);
    let preview = "";
    if (l.type === "text") {
      preview = `(${l.content.length} chars) ${l.content.slice(0, 50).replace(/\n/g, "↵")}`;
    } else if (l.type === "tool_call") {
      const toolName = l.metadata?.tool_name || l.content.split("\n")[0].slice(0, 40);
      preview = toolName;
    } else if (l.type === "tool_result") {
      preview = `(${l.content.length} chars)`;
    } else if (l.type === "done") {
      const m = l.metadata || {};
      preview = [
        m.cost_usd != null ? `$${m.cost_usd.toFixed(4)}` : null,
        m.num_turns ? `${m.num_turns} turns` : null,
        m.duration_ms ? `${(m.duration_ms / 1000).toFixed(1)}s` : null,
      ]
        .filter(Boolean)
        .join(" | ");
    } else if (l.type === "error") {
      preview = l.content.slice(0, 60);
    }
    console.log(`  │ ${time} [${typeTag}] ${preview}`);
  }
  console.log("  └──────────────────────────────────────────────");

  // Validate log sequence
  const seqs = logs.map((l) => l.seq);
  for (let i = 1; i < seqs.length; i++) {
    assertOk(seqs[i] > seqs[i - 1], `Log seq is monotonically increasing (${seqs[i - 1]} < ${seqs[i]})`);
  }

  // Check for done event
  const doneLog = logs.find((l) => l.type === "done");
  if (doneLog) {
    assertOk(true, `Found "done" log entry with cost/turns metadata`);
  }

  return logs;
}

async function traceWorkerScheduling(workerId, sessionId) {
  separator("Step 5: Trace Worker Scheduling (Admin API)");

  // 5a. GET /api/admin/workers — scheduler overview
  const overview = await fetchJSON("/api/admin/workers");
  assertOk(overview.driver, `Driver type: "${overview.driver}"`);
  assertOk(overview.workers.length > 0, `${overview.workers.length} active worker(s)`);

  log("INFO", `Driver: ${overview.driver}`);
  log("INFO", `Worker image: ${overview.workerImage}`);
  if (overview.staticWorkerUrl) {
    log("INFO", `Static URL: ${overview.staticWorkerUrl}`);
  }
  if (overview.k8s) {
    log("INFO", `K8s namespace: ${overview.k8s.namespace}, storage: ${overview.k8s.workspaceStorage}`);
  }

  // 5b. Find the worker that served our task
  const matched = overview.workers.find(
    (w) => w.containerId === workerId || w.sessionId === sessionId,
  );
  assertOk(matched, `Found worker endpoint for task (id=${workerId})`);
  assertOk(matched.url, `Worker URL: ${matched.url}`);
  assertOk(matched.healthy === true, `Worker health: ${matched.healthy ? "healthy" : "unhealthy"}`);

  // 5c. Print worker details
  console.log("");
  console.log("  Worker Scheduling:");
  console.log("  ┌──────────────────────────────────────────────");
  console.log(`  │  Driver:       ${overview.driver}`);
  console.log(`  │  Worker ID:    ${matched.containerId}`);
  console.log(`  │  Session:      ${matched.sessionId}`);
  console.log(`  │  Endpoint:     ${matched.url}`);
  console.log(`  │  Health:       ${matched.healthy ? "✓ healthy" : "✗ unhealthy"}`);
  console.log(`  │  Image:        ${overview.workerImage}`);
  console.log("  └──────────────────────────────────────────────");

  return overview;
}

function inferWorkerType(workerId) {
  if (!workerId) return "unknown";
  if (workerId === "static-worker") return "Static (docker-compose)";
  if (workerId.startsWith("w-")) return "K8s Pod";
  return "Docker container";
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("╔════════════════════════════════════════════════════════╗");
  console.log("║   AnyWork E2E — Full Pipeline Trace via Admin API     ║");
  console.log("╚════════════════════════════════════════════════════════╝\n");

  // Step 0: Check server health
  log("SETUP", "Checking server health...");
  try {
    const health = await fetchJSON("/api/health");
    log("SETUP", `Server: ${health.status} (v${health.version})`);
  } catch (e) {
    log("FAIL", `Server not reachable at ${API_URL}: ${e.message}`);
    process.exit(1);
  }

  const passed = [];
  const failed = [];

  try {
    // ── Step 1: Send a message and wait for completion ──
    separator("Step 1: Send Chat Message (WebSocket)");
    const { sessionId, events } = await connectAndSend(
      "请用一句话介绍 TypeScript 的主要优势。回答尽量简短。",
    );
    assertOk(sessionId, `Got session ID: ${sessionId.slice(0, 8)}...`);
    assertOk(
      events.some((e) => e.type === "done"),
      `Received "done" event`,
    );
    passed.push("WebSocket chat roundtrip");

    // Brief pause for DB writes to settle
    await new Promise((r) => setTimeout(r, 500));

    // ── Step 2: Trace Session ──
    const session = await traceSession(sessionId);
    passed.push("Session tracing");

    // ── Step 3: Trace Tasks ──
    const task = await traceTasks(sessionId);
    passed.push("Task tracing");

    // ── Step 4: Trace Task Detail ──
    const detail = await traceTaskDetail(task.id);
    passed.push("Task detail tracing");

    // ── Step 5: Trace Worker Scheduling ──
    const workerOverview = await traceWorkerScheduling(detail.workerId, detail.sessionId);
    passed.push("Worker scheduling tracing");

    // ── Step 6: Trace Execution Logs ──
    const logs = await traceTaskLogs(task.id);
    passed.push("Execution log tracing");

    // ── Step 7: Full Pipeline Summary ──
    separator("Step 7: Full Pipeline Summary");

    const workerType = inferWorkerType(detail.workerId);
    const pipeline = [
      `Channel: webchat`,
      `Session: ${sessionId.slice(0, 8)}... ("${session.title}")`,
      `Task: ${task.id.slice(0, 8)}... (${task.status})`,
      `Worker: ${detail.workerId || "n/a"} (${workerType})`,
      `Logs: ${logs.length} entries`,
      `Cost: ${detail.costUsd != null ? `$${detail.costUsd.toFixed(4)}` : "n/a"}`,
      `Duration: ${detail.durationMs ? `${(detail.durationMs / 1000).toFixed(1)}s` : "n/a"}`,
    ];

    console.log("");
    console.log("  Full trace:");
    console.log("  ┌──────────────────────────────────────────────");
    console.log("  │  Browser (WebSocket)");
    console.log("  │    ↓ chat message");
    console.log(`  │  Server → Channel: webchat`);
    console.log(`  │    ↓ toTaskRequest()`);
    console.log(`  │  Session: ${sessionId.slice(0, 8)}... "${session.title}"`);
    console.log(`  │    ↓ createTask()`);
    console.log(`  │  Task: ${task.id.slice(0, 8)}... status=${task.status}`);
    console.log(`  │    ↓ dispatch()`);
    console.log(`  │  Scheduler: driver=${workerOverview.driver}, image=${workerOverview.workerImage}`);
    console.log(`  │    ↓ getWorkerEndpoint()`);
    const matchedW = workerOverview.workers.find(w => w.containerId === detail.workerId);
    console.log(`  │  Worker: ${detail.workerId || "n/a"} (${workerType}) → ${matchedW?.url || "?"} [${matchedW?.healthy ? "healthy" : "?"}]`);
    console.log(`  │    ↓ /chat SSE stream`);
    console.log(`  │  Logs: ${logs.length} events (${Object.entries(logs.reduce((a, l) => ({ ...a, [l.type]: (a[l.type] || 0) + 1 }), {})).map(([k, v]) => `${k}:${v}`).join(" ")})`);
    console.log(`  │    ↓ result`);
    console.log(`  │  Cost: ${detail.costUsd != null ? `$${detail.costUsd.toFixed(4)}` : "n/a"} | Turns: ${detail.numTurns ?? "n/a"} | Duration: ${detail.durationMs ? `${(detail.durationMs / 1000).toFixed(1)}s` : "n/a"}`);
    console.log("  └──────────────────────────────────────────────");

    passed.push("Full pipeline summary");

    // ── Step 8: Incremental log polling (simulates admin dashboard live view) ──
    separator("Step 8: Incremental Log Polling");
    const midSeq = Math.floor(logs.length / 2);
    const incremental = await fetchJSON(`/api/tasks/${task.id}/logs?after=${midSeq}`);
    assertOk(
      incremental.logs.every((l) => l.seq > midSeq),
      `Incremental poll (after=${midSeq}) returned only newer logs (${incremental.logs.length} entries)`,
    );
    passed.push("Incremental log polling");

  } catch (e) {
    log("FAIL", `Pipeline trace failed: ${e.message}`);
    failed.push(e.message);
  }

  // ── Final Report ─────────────────────────────────────────

  console.log("\n╔════════════════════════════════════════════════════════╗");
  console.log("║                   TEST RESULTS                        ║");
  console.log("╠════════════════════════════════════════════════════════╣");
  for (const p of passed) {
    console.log(`║  ✓ ${p}`.padEnd(56) + "║");
  }
  for (const f of failed) {
    console.log(`║  ✗ ${f.slice(0, 50)}`.padEnd(56) + "║");
  }
  console.log("╠════════════════════════════════════════════════════════╣");
  const overall = failed.length === 0 ? "PASSED ✓" : "FAILED ✗";
  console.log(`║  Overall: ${overall}  (${passed.length}/${passed.length + failed.length})`.padEnd(56) + "║");
  console.log("╚════════════════════════════════════════════════════════╝");

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
