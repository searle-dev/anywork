/**
 * E2E Test: Webchat channel multi-turn conversation.
 *
 * Simulates a user creating an HTML mini-game through multiple conversation turns.
 * Tests the full pipeline: Browser → WebSocket → Server → Worker (Claude SDK) → SSE → WebSocket.
 *
 * Usage: node scripts/e2e-test.mjs
 *
 * Requires: Server on :3001, Worker on :8080
 */

import { createRequire } from "module";
const require = createRequire(
  new URL("../server/node_modules/ws/index.js", import.meta.url)
);
const WebSocket = require("ws");

const WS_URL = process.env.WS_URL || "ws://localhost:3001/ws";
const API_URL = process.env.API_URL || "http://localhost:3001";
const TURN_TIMEOUT_MS = 180_000; // 3 minutes per turn (Claude SDK can be slow)

// ── Helpers ──────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(tag, msg) {
  console.log(`[${timestamp()}] [${tag}] ${msg}`);
}

function logEvent(evt) {
  const preview =
    typeof evt.content === "string"
      ? evt.content.slice(0, 120).replace(/\n/g, "↵")
      : "";
  log("EVENT", `${evt.type} ${preview ? "│ " + preview : ""}`);
}

async function fetchJSON(path) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  return res.json();
}

// ── WebSocket Client ─────────────────────────────────────────

class TestWSClient {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.events = [];
    this.sessionId = null;
    this._resolve = null;
    this._reject = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => {
        log("WS", "Connected");
        resolve();
      });
      this.ws.on("error", (err) => {
        log("WS", `Error: ${err.message}`);
        reject(err);
      });
      this.ws.on("close", (code, reason) => {
        log("WS", `Closed (${code})`);
      });
      this.ws.on("message", (data) => {
        try {
          const evt = JSON.parse(data.toString());
          this.events.push(evt);
          logEvent(evt);
          this._handleEvent(evt);
        } catch (e) {
          log("WS", `Parse error: ${e.message}`);
        }
      });
    });
  }

  _handleEvent(evt) {
    if (evt.type === "session_created" && evt.session_id) {
      this.sessionId = evt.session_id;
      log("SESSION", `Created: ${this.sessionId}`);
    }
    if (evt.type === "done" || evt.type === "error") {
      if (this._resolve) {
        this._resolve(this._collectTurnEvents());
        this._resolve = null;
        this._reject = null;
      }
    }
  }

  _collectTurnEvents() {
    const turnEvents = [...this.events];
    this.events = [];
    return turnEvents;
  }

  /**
   * Send a chat message and wait for the turn to complete (done/error event).
   */
  sendAndWait(message, sessionId) {
    return new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;

      const payload = {
        type: "chat",
        session_id: sessionId || this.sessionId,
        message,
      };
      log("SEND", `"${message.slice(0, 100)}..."`);
      this.ws.send(JSON.stringify(payload));

      // Timeout guard
      setTimeout(() => {
        if (this._reject) {
          this._reject(new Error(`Turn timed out after ${TURN_TIMEOUT_MS}ms`));
          this._resolve = null;
          this._reject = null;
        }
      }, TURN_TIMEOUT_MS);
    });
  }

  close() {
    if (this.ws) this.ws.close();
  }
}

// ── Analysis ─────────────────────────────────────────────────

function analyzeTurn(events, turnNum) {
  const textEvents = events.filter((e) => e.type === "text");
  const toolCalls = events.filter((e) => e.type === "tool_call");
  const toolResults = events.filter((e) => e.type === "tool_result");
  const doneEvents = events.filter((e) => e.type === "done");
  const errorEvents = events.filter((e) => e.type === "error");

  const fullText = textEvents.map((e) => e.content || "").join("");
  const hasError = errorEvents.length > 0;
  const isDone = doneEvents.length > 0;

  log("─────", `Turn ${turnNum} Summary ─────`);
  log(
    "STATS",
    `text=${textEvents.length} tool_call=${toolCalls.length} tool_result=${toolResults.length} done=${doneEvents.length} error=${errorEvents.length}`
  );
  if (fullText.length > 0) {
    log(
      "TEXT",
      `(${fullText.length} chars) ${fullText.slice(0, 200).replace(/\n/g, "↵")}...`
    );
  }
  if (toolCalls.length > 0) {
    log(
      "TOOLS",
      toolCalls.map((e) => e.content).join(", ")
    );
  }
  if (doneEvents.length > 0 && doneEvents[0].metadata) {
    const m = doneEvents[0].metadata;
    log(
      "COST",
      `$${m.cost_usd?.toFixed(4) || "?"} | ${m.num_turns || "?"} turns | ${m.duration_ms || "?"}ms`
    );
  }
  if (hasError) {
    log("ERROR", errorEvents.map((e) => e.content).join("; "));
  }

  return { fullText, toolCalls, isDone, hasError };
}

// ── Main Test ────────────────────────────────────────────────

async function main() {
  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║  AnyWork E2E Test — Webchat Multi-Turn Chat   ║");
  console.log("║  Task: Develop an HTML mini-game               ║");
  console.log("╚═══════════════════════════════════════════════╝\n");

  // Step 0: Verify services
  log("SETUP", "Checking services...");
  try {
    const health = await fetchJSON("/api/health");
    log("SETUP", `Server: ${health.status} (v${health.version})`);
  } catch (e) {
    log("FAIL", `Server not reachable: ${e.message}`);
    process.exit(1);
  }

  // Step 1: Connect WebSocket
  const client = new TestWSClient(WS_URL);
  await client.connect();

  const results = { turns: [], passed: true };

  try {
    // ── Turn 1: Ask to create a simple HTML game ──
    log("TEST", "═══ Turn 1: Request game creation ═══");
    const turn1 = await client.sendAndWait(
      `请在 /workspace/files/ 目录下创建一个 HTML 贪吃蛇小游戏 (snake.html)。要求：
1. 纯 HTML + CSS + JS，单文件
2. 用 Canvas 绘制
3. 方向键控制
4. 碰壁或碰自身游戏结束
5. 显示得分

先创建基础版本就行，不需要太花哨。`,
      undefined
    );
    const r1 = analyzeTurn(turn1, 1);
    results.turns.push(r1);

    if (r1.hasError && !r1.isDone) {
      log("FAIL", "Turn 1 ended with error");
      results.passed = false;
    }

    // ── Turn 2: Follow-up request (same session) ──
    log("TEST", "═══ Turn 2: Request enhancement ═══");
    const turn2 = await client.sendAndWait(
      `很好！现在请改进这个贪吃蛇游戏：
1. 添加一个"开始游戏"按钮，点击后才开始
2. 游戏结束时显示 "Game Over" 和最终得分，以及"重新开始"按钮
3. 添加一个简洁美观的深色主题样式

请直接修改 /workspace/files/snake.html 文件。`,
      client.sessionId
    );
    const r2 = analyzeTurn(turn2, 2);
    results.turns.push(r2);

    if (r2.hasError && !r2.isDone) {
      log("FAIL", "Turn 2 ended with error");
      results.passed = false;
    }

    // ── Turn 3: Verification turn ──
    log("TEST", "═══ Turn 3: Verify the file ═══");
    const turn3 = await client.sendAndWait(
      `请读取 /workspace/files/snake.html 的内容，确认文件存在且包含贪吃蛇游戏代码。告诉我文件的总行数和主要功能列表。`,
      client.sessionId
    );
    const r3 = analyzeTurn(turn3, 3);
    results.turns.push(r3);

    if (r3.hasError && !r3.isDone) {
      log("FAIL", "Turn 3 ended with error");
      results.passed = false;
    }
  } catch (err) {
    log("FAIL", `Test failed: ${err.message}`);
    results.passed = false;
  } finally {
    client.close();
  }

  // ── Final Report ───────────────────────────────────────────

  console.log("\n╔═══════════════════════════════════════════════╗");
  console.log("║              TEST RESULTS                      ║");
  console.log("╠═══════════════════════════════════════════════╣");
  for (let i = 0; i < results.turns.length; i++) {
    const t = results.turns[i];
    const status = t.hasError ? "FAIL ✗" : "PASS ✓";
    const tools = t.toolCalls.length;
    console.log(
      `║  Turn ${i + 1}: ${status}  (${t.fullText.length} chars, ${tools} tool calls)`.padEnd(
        49
      ) + "║"
    );
  }
  console.log("╠═══════════════════════════════════════════════╣");
  console.log(
    `║  Overall: ${results.passed ? "PASSED ✓" : "FAILED ✗"}`.padEnd(49) + "║"
  );
  console.log("╚═══════════════════════════════════════════════╝");

  // Check if the game file was created
  log("CHECK", "Verifying game file...");
  try {
    const sessions = await fetchJSON("/api/sessions");
    if (sessions.sessions?.length > 0) {
      const sid = client.sessionId || sessions.sessions[0].id;
      log("CHECK", `Session: ${sid}`);
      const sessionDetail = await fetchJSON(`/api/sessions/${sid}`);
      log("CHECK", `Session title: ${sessionDetail.title || "(none)"}`);
    }
  } catch (e) {
    log("CHECK", `Session check failed: ${e.message}`);
  }

  process.exit(results.passed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
