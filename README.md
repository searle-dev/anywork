# AnyWork

[中文](README.zh.md) | English

Open-source cloud-native AI Agent scheduling and execution engine. Receives task requests from various channels (web chat, GitHub webhooks, Slack, etc.), schedules isolated worker containers running Claude Agent SDK, and streams results back.

AnyWork is **not** a user platform — it has no user management, auth, or billing. Those are handled by the deploying product layer.

## How it works

```
Channel  →  Task  →  Dispatcher  →  Worker (Claude Agent SDK)
                                          |
                                     MCP / Skills
```

1. A channel (webchat, GitHub, Slack…) receives an event and creates a Task
2. The Dispatcher resolves skills + MCP config, then calls `/prepare` and `/chat` on a Worker
3. The Worker runs Claude Agent SDK in an isolated container, streaming SSE events back
4. The server relays the stream to the browser via WebSocket (or pushes to a webhook for oneshot channels)

## Quick Start

### Prerequisites

- Docker & Docker Compose
- An API key from Anthropic (or an OpenAI-compatible provider via OpenRouter, etc.)

### Run locally

```bash
git clone https://github.com/searle-dev/anywork.git
cd anywork

cp .env.example .env
# Edit .env — fill in ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL)

docker compose up --build
# Open http://localhost:7000
```

### Run without Docker (development)

```bash
cd worker && pip install -e . && cd ..
cd server && npm install && cd ..
cd web && npm install && cd ..

bash scripts/dev.sh
```

## Architecture

```
anywork/
├── web/       # Next.js 15 + React 19 + Tailwind + Zustand  (port 7000)
├── server/    # Express + ws + better-sqlite3 + TypeScript   (port 3001)
├── worker/    # FastAPI + Claude Agent SDK                   (port 8080)
├── deploy/    # K8s manifests + cloud deployment configs
├── docs/      # Architecture & design docs
└── scripts/   # Dev/build helpers
```

### Key design decisions

**Channel abstraction**: Any event source (webchat, GitHub, Slack) implements the same `Channel` interface — `verify()`, `toTaskRequest()`, optionally `deliver()`. New integrations are one file.

**Claude Agent SDK per session**: One `ClaudeSDKClient` instance per session, one `query()` call per task. The worker is stateless between tasks but stateful within a session via conversation history.

**Driver pattern for container scheduling**: `ContainerDriver` interface with three implementations — `static` (docker-compose), `docker` (per-session containers), `k8s` (per-session Pods). Swap at runtime via `CONTAINER_DRIVER`.

**Skills via /prepare**: Before each task, the server resolves Agent Skills and writes them to the workspace. Claude Code discovers `SKILL.md` files natively.

**MCP via .mcp.json**: The server generates `.mcp.json` per task and the worker injects it into the workspace before running the agent.

**WebSocket + SSE bridge**: Browser ↔ WebSocket ↔ Server ↔ HTTP/SSE ↔ Worker.

## Configuration

Copy `.env.example` to `.env` and fill in your values.

### LLM provider

```bash
# Option A: Anthropic official
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Option B: Third-party (e.g. OpenRouter)
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1
ANTHROPIC_AUTH_TOKEN=sk-or-xxxxx
ANTHROPIC_API_KEY=                              # empty string required
ANTHROPIC_MODEL=anthropic/claude-sonnet-4-20250514
```

All `ANTHROPIC_*` and `CLAUDE_*` variables are automatically passed through to worker containers.

### Key variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `ANTHROPIC_MODEL` | Agent model | — |
| `TITLE_MODEL` | Model for session title generation | falls back to agent model |
| `CONTAINER_DRIVER` | `static` / `docker` / `k8s` | `static` |
| `K8S_NAMESPACE` | Kubernetes namespace for worker Pods | `anywork` |
| `K8S_WORKSPACE_STORAGE` | `emptydir` or `pvc` | `emptydir` |
| `K8S_IDLE_TTL_SECONDS` | Seconds before idle worker is GC'd | `1800` |
| `SERVER_PORT` | API server port | `3001` |

## Deployment

### Level 0 — docker-compose (local)

Default. Runs everything locally with a single static worker container.

```bash
docker compose up --build
```

### Level 1 — local Kubernetes (K3s / Kind)

```bash
CONTAINER_DRIVER=k8s
K8S_NAMESPACE=anywork
K8S_WORKSPACE_STORAGE=emptydir
```

See `deploy/` for manifests.

### Level 2 — cloud Kubernetes (GKE / EKS / AKS)

Use `K8S_WORKSPACE_STORAGE=pvc` for persistent per-session workspaces. See `deploy/` for production manifests and configuration.

## Extending AnyWork

### Add a new channel

1. Create `server/src/channel/mychannel.ts` implementing the `Channel` interface
2. Implement `verify()` (signature check), `toTaskRequest()`, optionally `deliver()`
3. Register in `server/src/index.ts` with `registerChannel()`

### Add a custom tool to the worker

```python
from claude_agent_sdk import tool, create_sdk_mcp_server

@tool("my_tool", "Description", {"param": str})
async def my_tool(args):
    return {"content": [{"type": "text", "text": "result"}]}

server = create_sdk_mcp_server("my-server", tools=[my_tool])
# Pass to ClaudeAgentOptions.mcp_servers
```

### Add a new container driver

1. Create `server/src/scheduler/drivers/newdriver.ts` implementing `ContainerDriver`
2. Add a case in `server/src/scheduler/container.ts`
3. Add config vars in `server/src/config.ts`

## Contributing

Contributions welcome. Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)
