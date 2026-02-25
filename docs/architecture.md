# Architecture

## System Overview

AnyWork is a three-tier architecture: **Web Frontend** → **API Server** → **Worker Containers**.

```
┌─────────────┐       ┌──────────────┐       ┌──────────────┐     ┌──────────┐
│   Browser    │──WS──▶│  API Server  │──HTTP─▶│   Worker     │────▶│  NAS /   │
│  (Next.js)  │◀──WS──│  (Express)   │◀─SSE──│  (nanobot)   │◀────│  Volume  │
└─────────────┘       └──────────────┘       └──────────────┘     └──────────┘
```

## Communication Protocol

### Browser ↔ Server: WebSocket

The browser maintains a persistent WebSocket connection to the server. Messages are JSON:

**Client → Server:**
```json
{ "type": "chat", "session_id": "abc-123", "message": "Hello" }
```

**Server → Client:**
```json
{ "type": "text", "content": "Hi there!", "session_id": "abc-123" }
{ "type": "tool_call", "content": "read_file", "metadata": { "path": "/workspace/..." } }
{ "type": "done", "session_id": "abc-123" }
```

### Server ↔ Worker: HTTP + SSE

The server calls the worker's REST API and receives streaming responses:

```
POST /chat
Content-Type: application/json
{ "session_id": "abc-123", "message": "Hello", "user_id": "user-001" }

Response: text/event-stream
event: text
data: {"content": "Hi", "metadata": {}}

event: text
data: {"content": " there!", "metadata": {}}

event: done
data: {"content": "", "metadata": {}}
```

## Driver Abstraction

### Container Drivers

```typescript
interface ContainerDriver {
  getWorkerEndpoint(userId: string): Promise<WorkerEndpoint>
  releaseWorker(userId: string): Promise<void>
  isHealthy(endpoint: WorkerEndpoint): Promise<boolean>
}
```

| Driver | Use Case | How it works |
|--------|----------|--------------|
| `static` | docker-compose | Single pre-running worker service |
| `docker` | Multi-user local | Spawns Docker container per user |
| `cloudrun` | Production (Phase 2) | Creates Cloud Run instances per user |

### Storage Drivers

| Driver | Use Case | Backing |
|--------|----------|---------|
| `local` | Development | Docker volumes / local filesystem |
| `filestore` | Production (Phase 2) | Google Cloud Filestore (NFS) |

## Worker (nanobot) Integration

We don't modify nanobot's core code. Instead, we add an adapter layer:

```
worker/
├── nanobot/              # Fork of HKUDS/nanobot (untouched core)
└── anywork_adapter/      # Our customization layer
    ├── http_channel.py   # FastAPI server exposing /chat, /health, /files
    ├── workspace_init.py # Initialize workspace directory structure
    └── main.py           # Entry point
```

The adapter provides an HTTP/SSE interface that the API server can call,
replacing nanobot's built-in Gateway mode (which is designed for chat platforms).

## User Workspace Structure

Each user gets a persistent directory:

```
/workspace/
├── SOUL.md              # Agent personality / system prompt
├── sessions/            # Conversation history (JSON per session)
│   ├── abc-123.json
│   └── def-456.json
├── files/               # User files and agent outputs
│   ├── uploads/
│   └── outputs/
└── skills/              # Custom agent skills
    └── my-skill/
```

## Security Model

- Each user's container runs in isolation
- Workspace paths are validated against traversal attacks
- Network access can be restricted via Docker network policies
- API authentication via JWT (dev mode: auto-assigned default user)
