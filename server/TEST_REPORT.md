# AnyWork Server — Test Report

## Summary

| Metric | Value |
|--------|-------|
| Test Framework | Vitest 3.2.4 |
| Test Files | 7 passed |
| Total Tests | 83 passed, 0 failed |
| Duration | ~1.5s |
| Overall Coverage (Stmts) | 65.19% |
| Overall Coverage (Branch) | 77.59% |
| Overall Coverage (Funcs) | 83.60% |
| Overall Coverage (Lines) | 65.19% |

## Test Files

### 1. `channel/webchat.test.ts` — 9 tests
WebChat channel 单元测试。

| Test | Status |
|------|--------|
| verify() always returns true | PASS |
| toTaskRequest() parses message, session_id, skills, mcp_servers | PASS |
| toTaskRequest() returns null when message is empty | PASS |
| toTaskRequest() returns null when message is missing | PASS |
| toTaskRequest() uses empty string for sessionId when not provided | PASS |
| toTaskRequest() defaults skills and mcp_servers to empty arrays | PASS |
| defaults have empty skills and mcpServers arrays | PASS |
| type is "webchat" | PASS |
| deliver method is undefined | PASS |

**Coverage**: webchat.ts — 100% Stmts / 100% Lines

### 2. `channel/webhook.test.ts` — 8 tests
Webhook 路由集成测试（使用 supertest）。

| Test | Status |
|------|--------|
| 404 for unknown channel type | PASS |
| 401 when verify fails | PASS |
| 200 + skipped when toTaskRequest returns null | PASS |
| 202 + taskId on successful webhook | PASS |
| Auto-create session in database | PASS |
| Create task with correct fields in DB (skills merge) | PASS |
| dispatch called asynchronously | PASS |
| No duplicate session on second webhook with same sessionId | PASS |

**Coverage**: channel.ts (route) — 98% Stmts / 100% Branch

### 3. `task/dispatcher.test.ts` — 10 tests
Dispatcher 调度流程集成测试（mock Worker HTTP + mock driver）。

| Test | Status |
|------|--------|
| Normal flow: getWorkerEndpoint → /chat(SSE) → completed | PASS |
| Call /prepare when task has skills | PASS |
| Write task_logs for SSE events (seq=0,1,2) | PASS |
| Forward SSE events to WebSocket | PASS |
| Mark task failed on SSE error event | PASS |
| Mark task failed when /chat returns non-200 | PASS |
| Mark task failed when /prepare returns non-200 | PASS |
| Call channel.deliver() on completed oneshot task | PASS |
| Send push notification on completed task | PASS |
| Handle stream without done event (auto-complete) | PASS |

**Coverage**: dispatcher.ts — 96.33% Stmts / 79.59% Branch

### 4. `scheduler/drivers.test.ts` — 10 tests
StaticDriver + DockerDriver 单元测试。

| Test | Status |
|------|--------|
| **StaticDriver**: same endpoint for any sessionId | PASS |
| **StaticDriver**: * mapping from listEndpoints | PASS |
| **StaticDriver**: no-op releaseWorker | PASS |
| **DockerDriver**: different ports for different sessions | PASS |
| **DockerDriver**: workspace directory mount for session isolation | PASS |
| **DockerDriver**: container naming with session id | PASS |
| **DockerDriver**: reuse endpoint when container healthy | PASS |
| **DockerDriver**: docker stop + rm on releaseWorker | PASS |
| **DockerDriver**: re-create container when health check fails | PASS |
| **DockerDriver**: list active endpoints | PASS |

**Coverage**: static.ts — 91.3% / docker.ts — 92.4%

### 5. `scheduler/k8s-pod.test.ts` — 18 tests
K8s driver Pod 挂载、隔离、Probe、TTL 专项测试。

| Test | Status |
|------|--------|
| Pod naming: w-s-{sessionId} | PASS |
| Labels include session-id | PASS |
| Volume mount at /workspace | PASS |
| emptyDir volume for emptydir mode | PASS |
| PVC creation for pvc mode (5Gi, RWO) | PASS |
| PVC isolation per session (ws-session1 vs ws-session2) | PASS |
| Environment variable injection (WORKSPACE_DIR, API_KEY, MODEL) | PASS |
| Resource requests and limits | PASS |
| Readiness and liveness probes | PASS |
| restartPolicy=Never | PASS |
| Correct service URL format | PASS |
| Cache reuse when healthy | PASS |
| Reuse existing Running pod | PASS |
| Throw on terminal pod phase (Failed) | PASS |
| Delete pod + service on releaseWorker | PASS |
| Sanitize long session IDs (max 63 chars) | PASS |
| Separate emptyDir pods for different sessions | PASS |
| No cleanup timer when idleTtlSeconds=0 | PASS |

**Coverage**: k8s.ts — 87.84% Stmts / 72.72% Branch

### 6. `ws/multi-turn.test.ts` — 10 tests
单 Session 多轮对话集成测试。

| Test | Status |
|------|--------|
| Two tasks under same session for consecutive chats | PASS |
| Reuse same worker endpoint for same session | PASS |
| Auto-create session on first chat without session_id | PASS |
| Complete tasks sequentially | PASS |
| Update session last_active after each chat | PASS |
| Trigger titleGen only on first chat (new session) | PASS |
| task_logs independent per task (seq starts from 0) | PASS |
| Handle ping/pong | PASS |
| Return error for invalid JSON | PASS |
| List all tasks via session tasks query | PASS |

**Coverage**: handler.ts — 90.58% Stmts / 78.57% Branch

### 7. `db/tasks.test.ts` — 18 tests
Task CRUD 和状态流转测试（真实 SQLite）。

| Test | Status |
|------|--------|
| createTask returns full TaskRecord | PASS |
| Store channelMeta as JSON | PASS |
| Store pushNotification as JSON | PASS |
| getTask existing | PASS |
| getTask non-existent returns undefined | PASS |
| updateTask partial fields | PASS |
| Update cost, num_turns, duration_ms | PASS |
| listTasksBySession in order | PASS |
| listTasksBySession empty | PASS |
| Status: pending → running → completed | PASS |
| Status: pending → running → failed | PASS |
| Status: pending → running → canceled | PASS |
| Insert and retrieve task logs | PASS |
| Filter logs by afterSeq | PASS |
| Limit returned logs | PASS |
| Count task logs | PASS |
| Return 0 for task with no logs | PASS |
| Return empty array for non-existent task logs | PASS |

**Coverage**: tasks.ts — 100% Stmts / 93.75% Branch

## Coverage by Module

| Module | Stmts | Branch | Funcs | Lines |
|--------|-------|--------|-------|-------|
| channel/webchat.ts | 100% | 100% | 100% | 100% |
| channel/registry.ts | 80% | 100% | 66.66% | 80% |
| routes/channel.ts | 98% | 100% | 100% | 98% |
| db/tasks.ts | 100% | 93.75% | 100% | 100% |
| db/schema.ts | 80% | 60% | 100% | 80% |
| task/dispatcher.ts | 96.33% | 79.59% | 100% | 96.33% |
| ws/handler.ts | 90.58% | 78.57% | 100% | 90.58% |
| scheduler/drivers/static.ts | 91.3% | 100% | 83.33% | 91.3% |
| scheduler/drivers/docker.ts | 92.4% | 75% | 100% | 92.4% |
| scheduler/drivers/k8s.ts | 87.84% | 72.72% | 88.88% | 87.84% |

## How to Run

```bash
cd server

# Run all tests
npm test

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
```
