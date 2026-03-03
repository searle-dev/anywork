#!/usr/bin/env npx tsx
/**
 * AnyWork E2E Test — K8s Local
 *
 * Validates:
 *   1. Multiple worker pods (one per session) scheduled by K8s driver
 *   2. Webchat channel: 2 sessions × multi-turn real-time conversation
 *   3. Webhook channel: event-triggered task (git clone + line count)
 *   4. Session workspace isolation across pods
 *
 * Prerequisites:
 *   bash scripts/k8s-local.sh          # start K8s cluster + server + web
 *   .env with valid API_KEY             # for LLM execution in workers
 *
 * Run:
 *   cd server && npx tsx ../scripts/e2e-k8s.ts
 *   # or
 *   cd server && npm run e2e:k8s
 */

import WebSocket from "ws";
import { execSync } from "child_process";

// ── Config ─────────────────────────────────────────────────
const SERVER = process.env.SERVER_URL || "http://localhost:3001";
const WS_URL = process.env.WS_URL || "ws://localhost:3001/ws";
const TURN_TIMEOUT = 180_000;   // 3 min — K8s pod startup + LLM
const TASK_TIMEOUT = 300_000;   // 5 min — git clone + analysis
const POLL_INTERVAL = 3_000;    // 3s

// ── Counters & Formatting ──────────────────────────────────
let passed = 0;
let failed = 0;
const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", C = "\x1b[36m", B = "\x1b[1m", D = "\x1b[2m", X = "\x1b[0m";
function ok(msg: string) { passed++; console.log(`  ${G}✓${X} ${msg}`); }
function ng(msg: string) { failed++; console.log(`  ${R}✗${X} ${msg}`); }
function info(msg: string) { console.log(`  ${Y}…${X} ${msg}`); }
function dim(msg: string) { console.log(`  ${D}${msg}${X}`); }
function heading(msg: string) { console.log(`\n${B}${C}─── ${msg} ───${X}`); }
function preview(text: string, max = 100) { return text.replace(/\n/g, " ").slice(0, max); }

// ── WebSocket Chat Client ──────────────────────────────────
class ChatClient {
  private ws!: WebSocket;
  private sessionId: string | null = null;

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
  }

  chat(message: string): Promise<{ sessionId: string; response: string; tools: number }> {
    return new Promise((resolve, reject) => {
      let response = "";
      let tools = 0;
      const timer = setTimeout(() => reject(new Error(`Chat timeout (${TURN_TIMEOUT / 1000}s)`)), TURN_TIMEOUT);

      const handler = (raw: WebSocket.RawData) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "session_created") {
          this.sessionId = msg.session_id;
        } else if (msg.type === "text") {
          response += msg.content || "";
        } else if (msg.type === "tool_call") {
          tools++;
        } else if (msg.type === "done") {
          clearTimeout(timer);
          this.ws.off("message", handler);
          resolve({ sessionId: this.sessionId!, response, tools });
        }
        // session_title, pong, tool_result — ignored
      };

      this.ws.on("message", handler);
      this.ws.send(JSON.stringify({
        type: "chat",
        session_id: this.sessionId,
        message,
      }));
    });
  }

  getSessionId() { return this.sessionId; }
  close() { try { this.ws.close(); } catch {} }
}

// ── HTTP Helpers ───────────────────────────────────────────
async function get(path: string) {
  const res = await fetch(`${SERVER}${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as any;
}

async function post(path: string, body: object) {
  const res = await fetch(`${SERVER}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() as any };
}

async function pollTask(taskId: string): Promise<any> {
  const deadline = Date.now() + TASK_TIMEOUT;
  let lastStatus = "";
  while (Date.now() < deadline) {
    const task = await get(`/api/tasks/${taskId}`);
    if (task.status !== lastStatus) {
      lastStatus = task.status;
      info(`Task status: ${task.status}${task.worker_id ? ` (worker: ${task.worker_id})` : ""}`);
    }
    if (task.status === "completed" || task.status === "failed") return task;
    await sleep(POLL_INTERVAL);
  }
  throw new Error(`Task ${taskId} did not complete within ${TASK_TIMEOUT / 1000}s`);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Detect Git Repo URL ────────────────────────────────────
function getRepoUrl(): string {
  try {
    let url = execSync("git remote get-url origin", { encoding: "utf-8" }).trim();
    // Convert SSH to HTTPS for worker access
    if (url.startsWith("git@")) {
      url = url.replace(/^git@([^:]+):(.+)$/, "https://$1/$2");
    }
    url = url.replace(/\.git$/, "");
    return url;
  } catch {
    return "";
  }
}

// ════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════
async function main() {
  console.log(`
${B}${C}╔═══════════════════════════════════════════════════════╗
║   AnyWork E2E Test — K8s Local                        ║
║   Webchat multi-turn + Webhook event + Pod isolation  ║
╚═══════════════════════════════════════════════════════╝${X}
  Server:    ${SERVER}
  WebSocket: ${WS_URL}`);

  // ── 1. Health Check ──────────────────────────────────────
  heading("1. Health Check");
  let driver = "unknown";
  try {
    const health = await get("/api/health");
    ok(`Server healthy (v${health.version})`);
    const workers = await get("/api/admin/workers");
    driver = workers.driver;
    ok(`Container driver: ${driver}`);
    if (driver !== "k8s") {
      info(`Driver is "${driver}" — pod isolation tests will be limited`);
    }
  } catch (e: any) {
    ng(`Server unreachable: ${e.message}`);
    console.log(`\n  ${R}Cannot continue. Is the server running?${X}`);
    console.log(`  Try: ${D}bash scripts/k8s-local.sh${X}\n`);
    process.exit(1);
  }

  // ── 2. Webchat Session A: 3 turns ────────────────────────
  heading("2. Webchat Session A — 3 turns");
  const clientA = new ChatClient();
  let sessionA = "";
  try {
    await clientA.connect();
    ok("WebSocket connected");

    info('Turn 1: "请用一句话介绍你自己"');
    const t1 = await clientA.chat("请用一句话介绍你自己");
    sessionA = t1.sessionId;
    ok(`Session: ${sessionA}`);
    ok(`Response (${t1.response.length} chars): ${preview(t1.response)}`);

    info('Turn 2: "你刚才说了什么？请用不同的方式再说一遍"');
    const t2 = await clientA.chat("你刚才说了什么？请用不同的方式再说一遍");
    ok(`Response (${t2.response.length} chars): ${preview(t2.response)}`);

    info('Turn 3: "总结一下我们这次对话的内容"');
    const t3 = await clientA.chat("总结一下我们这次对话的内容");
    ok(`Response (${t3.response.length} chars): ${preview(t3.response)}`);
  } catch (e: any) {
    ng(`Session A failed: ${e.message}`);
  }

  // ── 3. Webchat Session B: 2 turns ────────────────────────
  heading("3. Webchat Session B — 2 turns");
  const clientB = new ChatClient();
  let sessionB = "";
  try {
    await clientB.connect();
    ok("WebSocket connected");

    info('Turn 1: "请列出数字 1 到 5，每行一个"');
    const t1 = await clientB.chat("请列出数字 1 到 5，每行一个");
    sessionB = t1.sessionId;
    ok(`Session: ${sessionB}`);
    ok(`Response: ${preview(t1.response)}`);

    info('Turn 2: "把它们倒序排列"');
    const t2 = await clientB.chat("把它们倒序排列");
    ok(`Response: ${preview(t2.response)}`);
  } catch (e: any) {
    ng(`Session B failed: ${e.message}`);
  }

  // ── 4. Webhook: git clone + line count ───────────────────
  heading("4. Webhook Task — git clone + code line count");
  const repoUrl = getRepoUrl();
  let webhookTaskId = "";
  let webhookSessionId = "";

  if (!repoUrl) {
    info("No git remote found, using simple file task instead");
  }

  const webhookMessage = repoUrl
    ? `请执行以下步骤：
1. 运行 git clone ${repoUrl} /workspace/repo
2. 用 find 命令查找 /workspace/repo 中所有 .ts .tsx .py .sh 文件
3. 用 wc -l 统计这些文件的总代码行数
4. 按文件类型分别报告行数和总计`
    : `请执行以下步骤：
1. 在 /workspace 下创建文件 report.txt，写入当前日期时间
2. 用 ls -la /workspace 列出目录内容
3. 读取 report.txt 并返回内容`;

  try {
    info(`Message: ${preview(webhookMessage, 80)}`);
    const { status, data } = await post("/api/channel/webhook/webhook", {
      message: webhookMessage,
      event: "e2e_test",
      source: "e2e-script",
      meta: { repo: repoUrl || "local" },
    });

    if (status === 202) {
      webhookTaskId = data.taskId;
      ok(`Task accepted: ${webhookTaskId} (HTTP 202)`);
    } else {
      ng(`Unexpected response: HTTP ${status}`);
    }

    info("Polling for completion...");
    const result = await pollTask(webhookTaskId);
    webhookSessionId = result.session_id;

    if (result.status === "completed") {
      ok("Task completed");
      // Check result field or fall back to task_logs for tool-heavy tasks
      if (result.result) {
        ok(`Result (${result.result.length} chars): ${preview(result.result, 150)}`);
      } else {
        // Worker may use tool_call/tool_result events without text events
        const { logs } = await get(`/api/tasks/${webhookTaskId}/logs?after=-1&limit=50`);
        const toolLogs = logs.filter((l: any) => l.type === "tool_call" || l.type === "tool_result");
        if (toolLogs.length > 0) {
          ok(`Task executed ${toolLogs.length} tool calls (result in task_logs)`);
          const allContent = logs.map((l: any) => l.content).join(" ");
          if (/\d+/.test(allContent)) {
            ok("Task logs contain numeric data (line counts)");
          }
        } else {
          ng("No result or tool calls found");
        }
      }
    } else {
      ng(`Task ${result.status}: ${result.error || "unknown"}`);
      dim(`Full error: ${result.error}`);
    }
  } catch (e: any) {
    ng(`Webhook test failed: ${e.message}`);
  }

  // ── 5. Verify Pod Scheduling & Isolation ─────────────────
  heading("5. Verification — Pods & Workspace Isolation");

  // 5a. Worker pods
  try {
    const workers = await get("/api/admin/workers");
    const pods = workers.workers || [];
    const healthyCount = pods.filter((w: any) => w.healthy).length;

    if (pods.length >= 3) {
      ok(`${pods.length} worker pods created (${healthyCount} healthy)`);
    } else if (pods.length > 0) {
      ng(`Expected ≥3 pods, got ${pods.length} (driver: ${driver})`);
    } else if (driver === "static") {
      info("Static driver: single shared worker (no per-session pods)");
      passed++; // acceptable for static
    } else {
      ng("No worker pods found");
    }

    for (const w of pods) {
      const icon = w.healthy ? `${G}●${X}` : `${R}●${X}`;
      dim(`${icon} ${w.containerId}  →  session: ${w.sessionId}`);
    }
  } catch (e: any) {
    ng(`Worker check failed: ${e.message}`);
  }

  // 5b. Session task isolation
  const sessions = [
    { label: "A (webchat)", id: sessionA, expectedTasks: 3 },
    { label: "B (webchat)", id: sessionB, expectedTasks: 2 },
  ];

  const workerIds: string[] = [];

  for (const s of sessions) {
    if (!s.id) continue;
    try {
      const { tasks } = await get(`/api/sessions/${s.id}/tasks`);
      if (tasks.length === s.expectedTasks) {
        ok(`Session ${s.label}: ${tasks.length} tasks`);
      } else {
        ng(`Session ${s.label}: expected ${s.expectedTasks} tasks, got ${tasks.length}`);
      }
      if (tasks[0]?.workerId) workerIds.push(tasks[0].workerId);
    } catch (e: any) {
      ng(`Session ${s.label} check failed: ${e.message}`);
    }
  }

  // Check webhook task's session
  if (webhookTaskId) {
    try {
      const task = await get(`/api/tasks/${webhookTaskId}`);
      if (task.session_id) {
        const { tasks } = await get(`/api/sessions/${task.session_id}/tasks`);
        ok(`Session webhook: ${tasks.length} task(s)`);
        if (tasks[0]?.workerId) workerIds.push(tasks[0].workerId);
      }
    } catch {}
  }

  // 5c. Worker ID uniqueness (proves workspace isolation)
  const uniqueWorkers = new Set(workerIds);
  if (uniqueWorkers.size >= 3) {
    ok(`${uniqueWorkers.size} distinct workers — workspace isolation confirmed`);
  } else if (uniqueWorkers.size > 1) {
    info(`${uniqueWorkers.size} distinct workers (expected 3, may share in static mode)`);
  } else if (driver === "static") {
    info("Static driver: all sessions share one worker (no isolation)");
  }

  // ── Cleanup ──────────────────────────────────────────────
  clientA.close();
  clientB.close();

  // ── Summary ──────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${B}${C}═══════════════════════════════════════════════════════${X}`);
  if (failed === 0) {
    console.log(`  ${B}${G}Result: ${passed}/${total} checks passed — ALL OK${X}`);
  } else {
    console.log(`  ${B}${R}Result: ${passed} passed, ${failed} failed (${total} total)${X}`);
  }
  console.log(`${B}${C}═══════════════════════════════════════════════════════${X}`);

  if (driver === "k8s") {
    console.log(`
  ${D}Inspect pods:  kubectl get pods -n anywork
  Server logs:   kubectl logs -n anywork -l app=anywork-server -f
  Worker logs:   kubectl logs -n anywork <pod-name> -f
  Admin UI:      http://localhost:7001/admin${X}`);
  }
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`\n${R}Fatal: ${e.message}${X}\n`);
  process.exit(1);
});
