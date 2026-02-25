# AnyWork

Open-source cloud-native AI Agent platform. Each user gets a dedicated container running [nanobot](https://github.com/HKUDS/nanobot) with a persistent workspace — like having your own AI-powered computer in the cloud.

**Features**
- Chat with an AI agent that can read/write files, run code, and search the web
- Session auto-naming: conversations are titled automatically by LLM as you start them
- Workspace editor: customize the agent's persona (SOUL.md) and capabilities (AGENTS.md) from the web UI
- Persistent workspace: files and conversation history survive across sessions

## How it works

```
You  -->  Web UI (Next.js)  -->  API Server  -->  Container (nanobot agent)
                                                        |
                                                   NAS / Volume
                                                   (your files, chat history, skills)
```

1. You open the web interface and start a conversation
2. The server schedules a container for you (or reuses an existing one)
3. Inside the container, nanobot runs an agent loop with access to your workspace
4. Your conversation history, files, and custom skills persist between sessions

## Quick Start

### Prerequisites

- Docker & Docker Compose
- An API key from a supported LLM provider (Anthropic, OpenAI, DeepSeek, etc.)

### Run locally

```bash
# Clone the repo
git clone https://github.com/searle-dev/anywork.git
cd anywork

# Set up environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY (or other provider key)

# Start everything
docker compose up --build

# Open http://localhost:7000
```

### Run without Docker (development)

```bash
# Install dependencies
cd worker && pip install -e . && cd ..
cd server && npm install && cd ..
cd web && npm install && cd ..

# Start all services
bash scripts/dev.sh
```

## Architecture

```
anywork/
├── web/           # Next.js frontend - chat UI
├── server/        # Node.js API server - routing, scheduling, WebSocket
├── worker/        # Python worker - nanobot agent in a container
├── deploy/        # Cloud deployment configs (GCP, etc.)
└── docs/          # Documentation
```

### Key design decisions

**Container-per-user model**: Each user gets an isolated container with its own filesystem. This provides security isolation and allows the agent to freely read/write files without affecting other users.

**nanobot as agent runtime**: We use a fork of [HKUDS/nanobot](https://github.com/HKUDS/nanobot) (MIT, ~4000 lines, 11+ LLM providers, MCP support). Our customizations live in `worker/anywork_adapter/` to keep the fork easily updatable.

**Driver abstraction**: Container scheduling and storage are abstracted behind interfaces, making it easy to swap between local Docker (development) and Google Cloud Run + Filestore (production).

**WebSocket + SSE bridge**: The browser connects via WebSocket to the API server, which communicates with the worker via HTTP/SSE. This decouples the frontend from the agent runtime.

## Deployment

### Local (Docker Compose)

The default `docker-compose.yml` runs everything locally with Docker volumes for persistence.

### Google Cloud Run + Filestore (Phase 2)

See `deploy/gcloud/` for Cloud Run service definitions and Filestore setup. The same codebase runs in both environments — just swap the container driver from `static` to `cloudrun`.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Description | Default |
|----------|-------------|---------|
| `API_KEY` | LLM provider API key | - |
| `API_BASE_URL` | OpenAI-compatible endpoint | - |
| `MODEL` | Agent model (e.g. `anthropic/claude-sonnet-4-20250514`) | - |
| `TITLE_MODEL` | Model for session title generation | `openai/gpt-4o-mini` |
| `CONTAINER_DRIVER` | `static` / `docker` / `cloudrun` | `static` |
| `BRAVE_API_KEY` | Brave Search API key (enables web search) | - |

## Roadmap

- [x] Phase 1: Local Docker development environment
- [x] Session auto-naming (LLM generates title in parallel with agent response)
- [x] Workspace editor UI (SOUL.md / AGENTS.md editable from browser)
- [ ] Phase 2: Google Cloud Run + Filestore deployment
- [ ] Phase 3: OAuth login, Skills marketplace, MCP integration
- [ ] File upload/download in chat
- [ ] Container pre-warming pool

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

## Acknowledgements

- [nanobot](https://github.com/HKUDS/nanobot) by HKUDS - the ultra-lightweight agent runtime
- Inspired by [Claude Cowork](https://claude.ai), [OpenHands](https://github.com/OpenHands/OpenHands), and [Replit Agent](https://replit.com)
