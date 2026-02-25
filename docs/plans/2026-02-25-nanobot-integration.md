# Nanobot Integration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace AgentBridge's hand-rolled LLM call with nanobot's AgentLoop as the execution engine, enabling built-in file/shell/web tools while keeping the AgentBridge interface stable.

**Architecture:** AgentBridge keeps its `chat_stream()` SSE interface unchanged. Internally, a singleton nanobot `AgentLoop` (with `LiteLLMProvider` + full tool registry) is initialized from env vars. `process_direct()` is called per request; tool hints go to SSE `tool_call` events, final text goes as one `text` event. nanobot owns all session history in JSONL format.

**Tech Stack:** nanobot-ai 0.1.4, LiteLLM (inside nanobot), FastAPI SSE, Python asyncio

**Design doc:** `docs/plans/2026-02-25-nanobot-integration-design.md`

---

### Task 1: Config — docker-compose + .env.example

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Step 1: Add BRAVE_API_KEY to docker-compose worker env**

In `docker-compose.yml`, under `worker.environment`, add after the existing API vars:

```yaml
      - BRAVE_API_KEY=${BRAVE_API_KEY:-}
```

**Step 2: Document in .env.example**

Add section after the existing LLM vars:

```bash
# Web Search (optional) — get key at https://brave.com/search/api/
# Leave empty to disable the web_search tool
BRAVE_API_KEY=
```

**Step 3: Verify**

```bash
docker compose config | grep BRAVE
# Expected: BRAVE_API_KEY: ''
```

**Step 4: Commit**

```bash
git add docker-compose.yml .env.example
git commit -m "config: add optional BRAVE_API_KEY for nanobot web search"
```

---

### Task 2: Workspace — add AGENTS.md default

**Files:**
- Modify: `worker/anywork_adapter/workspace_init.py`

**Step 1: Add AGENTS.md content constant**

Add after the existing `DEFAULT_SOUL` constant:

```python
DEFAULT_AGENTS = """# AnyWork Agent Capabilities

## Available Tools

- **read_file / write_file / edit_file / list_dir** — Read and write files in the workspace
- **exec** — Run shell commands (sandboxed to workspace)
- **web_fetch** — Fetch and read content from a URL
- **web_search** — Search the web via Brave Search (if configured)
- **message** — Send follow-up messages to the user

## Workspace Layout

```
/workspace/
├── SOUL.md       # Your personality and style
├── AGENTS.md     # This file — capabilities reference
├── sessions/     # Conversation history (managed automatically)
└── files/        # User files and agent outputs
```

## Guidelines

- Save important outputs to /workspace/files/ so they persist
- Use exec for computation, not for network calls outside the workspace
- Prefer edit_file over write_file when modifying existing files
"""
```

**Step 2: Create AGENTS.md in init_workspace()**

Add after the SOUL.md creation block:

```python
    # Create default AGENTS.md if not exists
    agents_path = os.path.join(workspace_dir, "AGENTS.md")
    if not os.path.exists(agents_path):
        with open(agents_path, "w") as f:
            f.write(DEFAULT_AGENTS.strip() + "\n")
        logger.info("Created default AGENTS.md")
```

**Step 3: Verify**

```bash
docker compose restart worker
docker exec anywork-worker-1 cat /workspace/AGENTS.md
# Expected: AGENTS.md content shown above
```

**Step 4: Commit**

```bash
git add worker/anywork_adapter/workspace_init.py
git commit -m "feat: add AGENTS.md default to workspace init for nanobot ContextBuilder"
```

---

### Task 3: Replace AgentBridge internals with nanobot AgentLoop

This is the core task. Rewrite `http_channel.py` completely.

**Files:**
- Modify: `worker/anywork_adapter/http_channel.py`

**Step 1: Write the new http_channel.py**

Replace the entire file with:

```python
"""
HTTP/SSE Channel Adapter — nanobot backend.

AgentBridge keeps its chat_stream() SSE interface.
Internally uses nanobot AgentLoop as the execution engine.

Flow:
  API Server --POST /chat--> Worker --SSE stream--> API Server
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncGenerator

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

logger = logging.getLogger(__name__)

app = FastAPI(title="AnyWork Worker", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class ChatRequest(BaseModel):
    session_id: str = Field(description="Conversation session ID")
    message: str = Field(description="User message content")
    user_id: str = Field(default="default", description="User identifier")


class ChatEvent(BaseModel):
    type: str   # "text" | "tool_call" | "tool_result" | "error" | "done"
    content: str = ""
    metadata: dict = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# AgentBridge — wraps nanobot AgentLoop
# ---------------------------------------------------------------------------

class AgentBridge:
    """
    Bridge between HTTP API and nanobot AgentLoop.

    Initialises a single AgentLoop per worker process (singleton).
    Each chat request maps to a nanobot session key: "anywork:{session_id}".
    """

    def __init__(self, workspace_dir: str):
        self.workspace = Path(workspace_dir)
        self._agent = self._build_agent()
        logger.info("AgentBridge initialised with nanobot AgentLoop")

    def _build_agent(self):
        from nanobot.agent.loop import AgentLoop
        from nanobot.bus.queue import MessageBus
        from nanobot.providers.litellm_provider import LiteLLMProvider

        api_key = (
            os.environ.get("API_KEY")
            or os.environ.get("ANTHROPIC_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ""
        )
        api_base = os.environ.get("API_BASE_URL") or None
        model = os.environ.get("MODEL") or os.environ.get("DEFAULT_MODEL") or None
        brave_key = os.environ.get("BRAVE_API_KEY") or None

        if not api_key:
            logger.warning("No API key configured — nanobot will likely fail on LLM calls")

        provider = LiteLLMProvider(
            api_key=api_key or None,
            api_base=api_base,
            default_model=model or "gpt-4o",
        )

        bus = MessageBus()

        agent = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=self.workspace,
            model=model,
            brave_api_key=brave_key,
            restrict_to_workspace=True,   # sandbox file/shell to /workspace
        )

        if brave_key:
            logger.info("Web search enabled (Brave API key configured)")
        else:
            logger.info("Web search disabled (no BRAVE_API_KEY)")

        return agent

    async def chat_stream(
        self,
        session_id: str,
        message: str,
        user_id: str,
    ) -> AsyncGenerator[ChatEvent, None]:
        """
        Process a chat message and yield SSE events.

        Yields:
          tool_call events  — when nanobot calls a tool (via on_progress)
          text event        — full final response (one event, non-streaming)
          done event        — always last
        """
        session_key = f"anywork:{session_id}"
        pending_events: list[ChatEvent] = []

        async def on_progress(content: str, *, tool_hint: bool = False) -> None:
            # tool_hint=True  → agent is using a tool
            # tool_hint=False → intermediate reasoning text (skip for now)
            if tool_hint:
                pending_events.append(
                    ChatEvent(type="tool_call", content=content)
                )

        try:
            # Flush any queued tool_call events before final text
            # (process_direct returns after all tools complete)
            final_text = await self._agent.process_direct(
                content=message,
                session_key=session_key,
                channel="anywork",
                chat_id=session_id,
                on_progress=on_progress,
            )

            for event in pending_events:
                yield event

            if final_text:
                yield ChatEvent(type="text", content=final_text)
            else:
                yield ChatEvent(type="error", content="Agent returned empty response")

        except Exception as e:
            logger.error("AgentBridge error in session %s: %s", session_id, e)
            yield ChatEvent(type="error", content=str(e))

        finally:
            yield ChatEvent(type="done")


# ---------------------------------------------------------------------------
# Initialise bridge
# ---------------------------------------------------------------------------

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
bridge = AgentBridge(WORKSPACE_DIR)


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check():
    from nanobot.providers.litellm_provider import LiteLLMProvider
    return {
        "status": "healthy",
        "workspace": WORKSPACE_DIR,
        "workspace_exists": Path(WORKSPACE_DIR).is_dir(),
        "engine": "nanobot",
        "model": os.environ.get("MODEL", "(auto)"),
        "web_search": bool(os.environ.get("BRAVE_API_KEY")),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


@app.post("/chat")
async def chat(request: ChatRequest):
    """Process a chat message and return streaming SSE response."""

    async def event_generator():
        async for event in bridge.chat_stream(
            session_id=request.session_id,
            message=request.message,
            user_id=request.user_id,
        ):
            yield {
                "event": event.type,
                "data": json.dumps(
                    {"content": event.content, "metadata": event.metadata},
                    ensure_ascii=False,
                ),
            }

    return EventSourceResponse(event_generator())


@app.get("/sessions")
async def list_sessions():
    """List all conversation sessions in the workspace."""
    sessions = []
    sessions_dir = Path(WORKSPACE_DIR) / "sessions"
    if sessions_dir.is_dir():
        for fpath in sorted(sessions_dir.glob("anywork_*.jsonl")):
            session_id = fpath.stem.removeprefix("anywork_")
            messages = _read_jsonl_messages(fpath)
            if messages:
                last_ts = messages[-1].get("timestamp") or messages[-1].get("created_at", "")
                sessions.append({
                    "session_id": session_id,
                    "updated_at": last_ts,
                    "message_count": len(messages),
                })
    return {"sessions": sessions}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Return conversation history for a session."""
    fpath = Path(WORKSPACE_DIR) / "sessions" / f"anywork_{session_id}.jsonl"
    if not fpath.exists():
        raise HTTPException(status_code=404, detail="Session not found")
    messages = _read_jsonl_messages(fpath)
    return {"session_id": session_id, "messages": messages}


@app.get("/files")
async def list_files(path: str = ""):
    """List files in the workspace/files directory."""
    files_root = Path(WORKSPACE_DIR) / "files"
    target = (files_root / path).resolve()
    if not str(target).startswith(str(files_root.resolve())):
        raise HTTPException(status_code=403, detail="Access denied")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    entries = []
    for name in sorted(target.iterdir()):
        stat = name.stat()
        entries.append({
            "name": name.name,
            "type": "dir" if name.is_dir() else "file",
            "size": stat.st_size if name.is_file() else 0,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return {"path": path, "entries": entries}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_jsonl_messages(fpath: Path) -> list[dict]:
    """Parse a nanobot JSONL session file, returning only user/assistant messages."""
    messages = []
    try:
        with open(fpath, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                # Skip metadata lines
                if data.get("_type") == "metadata":
                    continue
                role = data.get("role")
                if role in ("user", "assistant") and data.get("content"):
                    messages.append({
                        "role": role,
                        "content": data["content"],
                        "timestamp": data.get("timestamp", ""),
                    })
    except OSError:
        pass
    return messages
```

**Step 2: Verify the file looks correct**

```bash
cat worker/anywork_adapter/http_channel.py | head -20
# Expected: module docstring about nanobot backend
```

**Step 3: Commit**

```bash
git add worker/anywork_adapter/http_channel.py
git commit -m "feat: replace AgentBridge internals with nanobot AgentLoop"
```

---

### Task 4: Delete llm_provider.py (no longer needed)

**Files:**
- Delete: `worker/anywork_adapter/llm_provider.py`

**Step 1: Confirm nothing else imports it**

```bash
grep -r "llm_provider" worker/ --include="*.py"
# Expected: no results (http_channel.py no longer imports it)
```

**Step 2: Delete**

```bash
git rm worker/anywork_adapter/llm_provider.py
git commit -m "chore: remove llm_provider.py (replaced by nanobot LiteLLMProvider)"
```

---

### Task 5: Update main.py — remove old provider init

**Files:**
- Modify: `worker/anywork_adapter/main.py`

**Step 1: Read current main.py**

```bash
cat worker/anywork_adapter/main.py
```

**Step 2: Remove any import or call to `llm_provider` / `get_provider`**

The bridge is now initialized at module load in `http_channel.py`. `main.py` should only start uvicorn — remove any explicit LLM provider initialization if present.

**Step 3: Commit**

```bash
git add worker/anywork_adapter/main.py
git commit -m "chore: remove explicit LLM provider init from main.py"
```

---

### Task 6: Update server sessions route — read nanobot JSONL

**Files:**
- Modify: `server/src/routes/sessions.ts`

**Step 1: Update the messages proxy endpoint**

The `/sessions/:id/messages` endpoint already proxies to `GET worker/sessions/{id}`.
No change needed here — nanobot's `_read_jsonl_messages()` already returns `{role, content, timestamp}` which is what the server forwards. ✓

**Step 2: Verify end-to-end after rebuild**

```bash
# Get a session ID from the sidebar, then:
NO_PROXY='*' curl -s http://localhost:3100/api/sessions/<id>/messages | python3 -m json.tool
# Expected: { "messages": [ { "role": "user", "content": "...", "timestamp": "..." }, ... ] }
```

---

### Task 7: Rebuild and smoke test

**Step 1: Build and restart worker**

```bash
docker compose build worker && docker compose up -d worker
docker logs -f anywork-worker-1
# Expected: "AgentBridge initialised with nanobot AgentLoop"
#           "Web search disabled (no BRAVE_API_KEY)" or enabled
```

**Step 2: Health check**

```bash
NO_PROXY='*' curl -s http://localhost:3100/api/health | python3 -m json.tool
# Expected: { "status": "ok", ... }
# (server health — always passes)

docker exec anywork-server-1 node -e "
const http = require('http');
http.get('http://worker:8080/health', r => {
  let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(d));
});
"
# Expected: { "status": "healthy", "engine": "nanobot", ... }
```

**Step 3: Send a chat message in the browser**

Open http://localhost:7100, send a message, verify:
- Response appears (non-streaming, arrives all at once)
- If message triggers tool use, tool_call bubble shows in chat

**Step 4: Verify session history persists across refresh**

1. Send a message
2. Refresh the page
3. Click the session in sidebar
4. Verify history loads back from nanobot JSONL

**Step 5: Commit any final tweaks and tag**

```bash
git add -A
git commit -m "feat: nanobot integration complete — AgentLoop replaces hand-rolled LLM"
```
