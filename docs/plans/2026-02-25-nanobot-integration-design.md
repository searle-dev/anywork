# Nanobot Integration Design

## Goal

Replace the hand-rolled LLM call in `AgentBridge` with nanobot's `AgentLoop` as the execution engine, while keeping the `AgentBridge` interface stable so future backends (Claude Code, Gemini CLI, etc.) can be swapped in via the same contract.

## Key Decisions

| Question | Decision |
|----------|---------|
| Integration pattern | Approach A: keep `AgentBridge` shell, replace internals |
| Text streaming | Non-streaming — full response returned as one `text` SSE event |
| Tools | All nanobot built-ins enabled (file, shell, web fetch, web search) |
| Web Search | Optional — enabled only when `BRAVE_API_KEY` is set |
| ACP protocol | Skip for now — `AgentBridge` is the right abstraction boundary |
| Online SOUL/AGENTS editing | Deferred — noted as future Web UI feature |

## Architecture

```
Browser ←WS→ Server ←HTTP/SSE→ Worker (FastAPI)
                                    │
                               AgentBridge          ← interface unchanged
                                    │
                             nanobot AgentLoop       ← new engine
                            ┌───────┴────────┐
                      LiteLLMProvider    ToolRegistry
                      (env vars)         file/shell/web/mcp
```

### AgentBridge Contract (unchanged)

```python
async def chat_stream(session_id, message, user_id) -> AsyncGenerator[ChatEvent]:
    # yields: tool_call | tool_result | text | error | done events
```

### Nanobot AgentLoop (singleton per worker process)

Initialized once at module load with:
- `LiteLLMProvider(api_key, api_base, default_model)` — from env vars
- `workspace = Path(WORKSPACE_DIR)`
- `brave_api_key` — optional, from env vars
- `restrict_to_workspace=True` — shell/file tools sandboxed to workspace

### SSE Event Mapping

| nanobot callback | SSE event type |
|-----------------|---------------|
| `on_progress(text, tool_hint=True)` | `tool_call` |
| `process_direct()` return value | `text` (full response) |
| exception | `error` |
| always at end | `done` |

## Session Management

nanobot `SessionManager` owns all history storage.

- Session key format: `anywork:{session_uuid}` (e.g. `anywork:abc-123`)
- Storage: `/workspace/sessions/anywork_abc-123.jsonl` (nanobot JSONL format)
- Current JSON files (`{uuid}.json`) are deprecated — new sessions use JSONL only

### Worker `/sessions/{id}` API Update

Currently reads `{uuid}.json`. Must be updated to read nanobot JSONL:

```
/workspace/sessions/anywork_{id}.jsonl
Each line: {"role": "user"|"assistant", "content": "...", ...} or {"_type": "metadata", ...}
```

## Workspace Files

Both files created by `workspace_init.py` if not present (idempotent):

- **`AGENTS.md`** — capability declaration (tools, boundaries). nanobot reads this.
- **`SOUL.md`** — personality/style. Already exists, keep as-is.

Future: Web UI to edit these files online.

## Configuration

### `.env` / `docker-compose.yml`

```bash
# Existing (unchanged)
API_STYLE=openai
API_BASE_URL=https://openrouter.ai/api/v1
API_KEY=sk-or-xxxxx
MODEL=anthropic/claude-sonnet-4.6

# New optional
BRAVE_API_KEY=         # empty = web search tool disabled
```

## Files Changed

| File | Change |
|------|--------|
| `worker/anywork_adapter/http_channel.py` | Replace `AgentBridge` internals with nanobot `AgentLoop` |
| `worker/anywork_adapter/llm_provider.py` | Delete (replaced by nanobot `LiteLLMProvider`) |
| `worker/anywork_adapter/workspace_init.py` | Add default `AGENTS.md` |
| `worker/anywork_adapter/main.py` | Pass `BRAVE_API_KEY` to bridge init |
| `docker-compose.yml` | Add `BRAVE_API_KEY=${BRAVE_API_KEY:-}` to worker env |
| `.env.example` | Document `BRAVE_API_KEY` as optional |
| `server/src/routes/sessions.ts` | Update `/sessions/:id/messages` to read JSONL |
