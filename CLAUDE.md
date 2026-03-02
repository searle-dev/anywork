# CLAUDE.md - AnyWork Project Guide

## What is this project?

AnyWork is an open-source cloud-native AI Agent scheduling and execution engine. It receives task requests from various channels (web chat, GitHub webhooks, Slack, etc.), schedules isolated worker containers running Claude Agent SDK, and streams results back.

AnyWork is NOT a user platform — it has no user management, auth, or billing. These are handled by the deploying product layer.

Architecture: `Channel → Task → Dispatcher → Worker (Claude Agent SDK)`

## Quick Start

```bash
# Docker Compose (recommended)
cp .env.example .env   # fill in API_KEY, API_BASE_URL, MODEL
docker compose up --build
# Open http://localhost:7000

# Local dev (without Docker)
bash scripts/dev.sh
```

## Project Structure

```
anywork/
├── web/           # Next.js 15 + React 19 + Tailwind + Zustand  (port 7000)
├── server/        # Express + ws + better-sqlite3 + TypeScript   (port 3001)
├── worker/        # FastAPI + claude-agent-sdk                   (port 8080)
├── deploy/        # K8s manifests + cloud deployment configs
├── docs/          # Architecture & design docs
│   └── plans/     # architecture-v2.md — full V2 design document
├── scripts/       # Dev/build helper scripts
├── docker-compose.yml
├── .env.example
└── LICENSE        # MIT
```

## Core Concepts

```
Channel → Task → Dispatcher → Worker → MCP/Skills
```

| Concept | Description |
|---------|-------------|
| **Channel** | Event ingress: webchat, github, slack… Verifies, translates, declares default skills/MCP |
| **Session** | Execution environment: workspace + conversation history continuity |
| **Task** | Single request-response cycle, the scheduling and observability unit |
| **TaskLog** | Per-task execution log entries (for debugging and polling) |
| **Worker** | Isolated container running Claude Agent SDK (ClaudeSDKClient) |
| **Skill** | Agent Skills open standard (agentskills.io), SKILL.md format |
| **MCP** | Model Context Protocol, standard bridge between Agent and external systems |

### Entity Relationships

```
Session 1 ──── N Task 1 ──── N TaskLog
```

- **No userId** — anywork routes by sessionId only. Identity is the deployer's concern.
- **Task status**: pending → running → input_required → completed / failed / canceled

## Service Communication

```
Browser ←WebSocket→ Server ←HTTP/SSE→ Worker (Claude Agent SDK)
```

1. Browser sends `{ type: "chat", session_id, message }` via WebSocket
2. Server creates a Task, resolves skills, gets/creates Worker endpoint
3. Server calls `/prepare` (injects skills + .mcp.json), then `/chat`
4. Worker streams SSE events; Server writes task_logs + forwards via WebSocket
5. For oneshot channels (GitHub, Slack): Server calls `channel.deliver()` with result

## Key Commands

| Task | Command |
|------|---------|
| Start all (Docker) | `docker compose up --build` |
| Start all (local) | `bash scripts/dev.sh` |
| Dev server only | `cd server && npm run dev` |
| Dev web only | `cd web && npm run dev` |
| Dev worker only | `cd worker && python -m anywork_adapter.main` |
| Build server | `cd server && npm run build` |
| Build web | `cd web && npm run build` |
| TypeScript check | `cd server && npx tsc --noEmit` |

## Key Files to Know

### Web (Next.js)
- `web/src/app/page.tsx` — Main page, loads sessions, initializes WebSocket
- `web/src/stores/chatStore.ts` — Zustand store: sessions, messages, streaming state
- `web/src/hooks/useWebSocket.ts` — WebSocket connection, reconnect, message dispatch
- `web/src/components/chat/ChatPanel.tsx` — Chat message list + streaming display
- `web/src/components/chat/InputBar.tsx` — Message input with Enter-to-send
- `web/src/components/chat/MessageBubble.tsx` — User/assistant message rendering (markdown)
- `web/src/components/sidebar/Sidebar.tsx` — Session list + new chat button + settings gear
- `web/src/components/settings/WorkspaceEditor.tsx` — Modal editor for SOUL.md / AGENTS.md
- `web/src/lib/api.ts` — `API_URL`, `WS_URL` constants + fetch helpers
- `web/src/lib/types.ts` — TypeScript interfaces (Session, ChatMessage, ServerEvent, etc.)

### Server (Express + TypeScript)
- `server/src/index.ts` — Entry: Express app, WebSocket server, channel registration, routes
- `server/src/config.ts` — Env var config (reads from .env)
- `server/src/channel/types.ts` — Channel, TaskRequest, MCPServerConfig interfaces
- `server/src/channel/registry.ts` — Channel registration Map
- `server/src/channel/webchat.ts` — WebChat channel (verify=true, translates WS messages)
- `server/src/db/schema.ts` — SQLite schema (sessions, tasks, task_logs)
- `server/src/db/tasks.ts` — Task + TaskLog CRUD functions
- `server/src/task/dispatcher.ts` — **Core**: resolve skills → /prepare → /chat → stream → deliver
- `server/src/ws/handler.ts` — WebSocket handler, uses Channel + Dispatcher pipeline
- `server/src/routes/sessions.ts` — REST CRUD for sessions
- `server/src/routes/tasks.ts` — Task query / logs / cancel API
- `server/src/routes/channel.ts` — Unified webhook entry (`POST /api/channel/:type/webhook`)
- `server/src/routes/workspace.ts` — Proxy GET/PUT for workspace files
- `server/src/lib/titleGen.ts` — LLM title generation (fire-and-forget)
- `server/src/scheduler/container.ts` — Container driver factory
- `server/src/scheduler/drivers/interface.ts` — `ContainerDriver` interface (sessionId-based)
- `server/src/scheduler/drivers/static.ts` — Static driver (docker-compose)
- `server/src/scheduler/drivers/docker.ts` — Docker driver (per-session containers)
- `server/src/scheduler/drivers/k8s.ts` — K8s driver (per-session Pods)

### Worker (Python FastAPI + Claude Agent SDK)
- `worker/anywork_adapter/main.py` — Entry: init workspace, start uvicorn
- `worker/anywork_adapter/executor.py` — **Core**: SessionExecutor wrapping ClaudeSDKClient
- `worker/anywork_adapter/http_app.py` — FastAPI: /prepare, /chat (SSE), /cancel, /health
- `worker/anywork_adapter/workspace_init.py` — Creates workspace dirs + default SOUL.md

## Architecture Patterns

- **Channel abstraction**: unified event ingress from any source (webchat, GitHub, Slack, etc.)
- **Task pipeline**: Channel → TaskRecord → Dispatcher → Worker → SSE stream
- **Driver pattern** for container scheduling: `ContainerDriver` → `StaticDriver` / `DockerDriver` / `K8sDriver`
- **ClaudeSDKClient per session**: one client instance per session, one `query()` per task
- **Skills via /prepare**: Server resolves skills, Worker writes to workspace before each task
- **MCP via .mcp.json**: Server generates config, Claude Code discovers it natively
- **Zustand** store for frontend state
- **SSE streaming** from worker, relayed via WebSocket to browser

## Environment Variables

### LLM (passed to worker via docker-compose or K8s env)
```bash
ANTHROPIC_API_KEY=sk-ant-xxxxx
# or OpenAI-compatible
API_KEY=sk-or-xxxxx
API_BASE_URL=https://openrouter.ai/api/v1
MODEL=anthropic/claude-sonnet-4-20250514
```

### Server
```bash
SERVER_PORT=3001
CONTAINER_DRIVER=static    # static | docker | k8s
STATIC_WORKER_URL=http://worker:8080
DB_DIR=/data

# Title generation
API_KEY=...
API_BASE_URL=...
TITLE_MODEL=openai/gpt-4o-mini
```

### Worker
```bash
WORKSPACE_DIR=/workspace
WORKER_PORT=8080
```

### Web (build-time ARGs)
```bash
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
```

### K8s Driver
```bash
K8S_NAMESPACE=anywork
K8S_WORKER_IMAGE=anywork-worker:latest
K8S_WORKSPACE_STORAGE=emptydir   # emptydir | pvc
K8S_IDLE_TTL_SECONDS=1800
```

## API Reference

### Task API
```
GET    /api/tasks/:taskId              → task status + result
GET    /api/tasks/:taskId/logs?after=0 → incremental execution logs
POST   /api/tasks/:taskId/cancel       → cancel running task
```

### Session API
```
GET    /api/sessions            → list all sessions
POST   /api/sessions            → create session
GET    /api/sessions/:id        → session details
PATCH  /api/sessions/:id        → update title
DELETE /api/sessions/:id        → delete session + tasks
GET    /api/sessions/:id/messages → message history (proxied from worker)
```

### Channel Webhook
```
POST   /api/channel/:type/webhook → unified webhook entry (returns 202 + taskId)
```

### Health
```
GET    /api/health              → { status, version }
```

### WebSocket (`ws://localhost:3001/ws`)
```jsonc
// Client → Server
{ "type": "chat", "session_id": "uuid", "message": "Hello", "skills": [], "mcp_servers": [] }
{ "type": "ping" }

// Server → Client
{ "type": "text", "content": "Hi", "session_id": "uuid" }
{ "type": "tool_call", "content": "tool_name", "metadata": {...} }
{ "type": "tool_result", "content": "result", "metadata": {...} }
{ "type": "error", "content": "error message" }
{ "type": "done", "session_id": "uuid" }
{ "type": "session_created", "session_id": "new-uuid" }
{ "type": "session_title", "content": "title", "session_id": "uuid" }
{ "type": "pong" }
```

### Worker Internal API
```
POST /prepare     → Server→Worker: inject skills + MCP config
POST /chat        → Server→Worker: execute task, return SSE stream
POST /cancel      → Server→Worker: interrupt current task
GET  /health      → health check
```

### Workspace API (proxied via server or direct to worker)
```
GET  /api/workspace/soul        → { file, content }
PUT  /api/workspace/soul        Body: { content }
GET  /api/workspace/agents      → { file, content }
PUT  /api/workspace/agents      Body: { content }
```

## Code Conventions

- **TypeScript**: strict mode, `@/*` path aliases, camelCase vars, PascalCase types
- **Python**: `from __future__ import annotations`, type hints everywhere, `logging.getLogger(__name__)`
- **React**: functional components only, Zustand for state, `"use client"` directive
- **CSS**: Tailwind utility classes, CSS custom properties for theming (dark mode default)
- **Error handling**: try/catch with logging, graceful fallbacks

## Workspace Structure (per session, mounted at /workspace)

```
/workspace/
├── SOUL.md              # Agent system prompt (editable via UI)
├── .mcp.json            # MCP server config (written by /prepare)
├── sessions/            # Conversation history (JSONL per session)
├── files/               # User files and agent outputs
└── skills/              # Agent Skills (SKILL.md standard, written by /prepare)
    └── code-review/
        └── SKILL.md
```

## Deployment Tiers

| Level | Runtime | Driver | Database | Channels |
|-------|---------|--------|----------|----------|
| **0** | docker-compose | static | SQLite | webchat |
| **1** | local K8s (K3s/Kind) | k8s | SQLite | webchat + webhook |
| **2** | cloud K8s (GKE/EKS/AKS) | k8s | PostgreSQL | all |

## Common Tasks

### Adding a new Channel
1. Create `server/src/channel/mychannel.ts` implementing `Channel` interface
2. Register in `server/src/index.ts` with `registerChannel()`
3. Implement `verify()` (signature check), `toTaskRequest()`, optionally `deliver()`

### Adding a new container driver
1. Create `server/src/scheduler/drivers/newdriver.ts` implementing `ContainerDriver`
2. Add case in `server/src/scheduler/container.ts` factory
3. Add config vars in `server/src/config.ts`

### Adding a custom tool to Worker
Use `@tool` decorator + `create_sdk_mcp_server()` from claude-agent-sdk:
```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("my_tool", "Description", {"param": str})
async def my_tool(args):
    return {"content": [{"type": "text", "text": "result"}]}

server = create_sdk_mcp_server("my-server", tools=[my_tool])
# Pass to ClaudeAgentOptions.mcp_servers
```

## Design Document

Full V2 architecture design (14 sections) is at `docs/plans/architecture-v2.md`, covering:
- Core concepts, data model, DB schema
- Channel / Task / Dispatcher / Worker design
- Skill resolution and injection
- Claude Agent SDK (ClaudeSDKClient) usage
- Result delivery (WebSocket / push webhook / polling)
- Deployment tiers (Level 0–2)
- Design decision records (ADRs)
