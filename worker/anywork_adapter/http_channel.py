"""
HTTP/SSE Channel Adapter.

Supports two execution engines selected via the ENGINE env var:
  ENGINE=nanobot     (default) — nanobot AgentLoop
  ENGINE=claudecode  — Claude Code CLI subprocess

On startup the worker reads:
  SKILLS     comma-separated list of skill names to load
  MCP_SERVERS JSON array of MCP server configs (see WorkerSpec.MCPServerConfig)
  ENGINE     "nanobot" | "claudecode"

The skill prompts are appended to the agent's base system prompt so the
agent gains specialised expertise without losing its base personality.

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

from anywork_adapter.skill_loader import get_skills_from_env, load_skill_prompts

logger = logging.getLogger(__name__)

app = FastAPI(title="AnyWork Worker", version="0.2.0")

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
# Engine bootstrap
# ---------------------------------------------------------------------------

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
ENGINE = os.environ.get("ENGINE", "nanobot").lower()

# Load skills at startup (set by K8sDriver as SKILLS env var)
_skill_names = get_skills_from_env()
_skill_prompts = load_skill_prompts(_skill_names)
if _skill_names:
    logger.info("Loaded skills: %s", ", ".join(_skill_names))

# Parse MCP servers from env (set by K8sDriver as MCP_SERVERS env var)
_raw_mcp = os.environ.get("MCP_SERVERS", "").strip()
_mcp_servers: list[dict] = []
if _raw_mcp:
    try:
        _mcp_servers = json.loads(_raw_mcp)
        logger.info("MCP servers configured: %s", [s.get("name") for s in _mcp_servers])
    except json.JSONDecodeError as e:
        logger.warning("Failed to parse MCP_SERVERS env var: %s", e)


def _build_nanobot_engine():
    """Construct a nanobot AgentLoop with skill prompts injected."""
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

    # nanobot appends the extra_system_prompt to the base SOUL.md content
    extra_prompt = _skill_prompts if _skill_prompts else None

    agent = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=Path(WORKSPACE_DIR),
        model=model,
        brave_api_key=brave_key,
        restrict_to_workspace=True,
        extra_system_prompt=extra_prompt,
    )

    if brave_key:
        logger.info("Web search enabled (Brave API key configured)")

    return agent


def _build_claude_engine():
    """Construct a ClaudeCode subprocess engine."""
    from anywork_adapter.engine_claude import ClaudeCodeEngine
    return ClaudeCodeEngine(
        workspace_dir=WORKSPACE_DIR,
        skill_prompts=_skill_prompts,
    )


# ---------------------------------------------------------------------------
# Engine singleton
# ---------------------------------------------------------------------------

if ENGINE == "claudecode":
    logger.info("Starting with ClaudeCode engine")
    _claude_engine = _build_claude_engine()
    _nanobot_agent = None
else:
    logger.info("Starting with nanobot engine")
    _nanobot_agent = _build_nanobot_engine()
    _claude_engine = None


# ---------------------------------------------------------------------------
# AgentBridge — unified streaming interface over both engines
# ---------------------------------------------------------------------------

class AgentBridge:
    """
    Wraps whichever engine is active and exposes a single chat_stream() method
    that yields ChatEvent objects.
    """

    def __init__(self, workspace_dir: str):
        self.workspace = Path(workspace_dir)

    async def chat_stream(
        self,
        session_id: str,
        message: str,
        user_id: str,
    ) -> AsyncGenerator[ChatEvent, None]:
        if ENGINE == "claudecode":
            async for ev in self._stream_claudecode(session_id, message, user_id):
                yield ev
        else:
            async for ev in self._stream_nanobot(session_id, message, user_id):
                yield ev

    # ── nanobot backend ──────────────────────────────────────────────────────

    async def _stream_nanobot(
        self,
        session_id: str,
        message: str,
        user_id: str,
    ) -> AsyncGenerator[ChatEvent, None]:
        assert _nanobot_agent is not None
        session_key = f"anywork:{session_id}"
        pending_events: list[ChatEvent] = []

        async def on_progress(content: str, *, tool_hint: bool = False) -> None:
            if tool_hint:
                pending_events.append(ChatEvent(type="tool_call", content=content))

        try:
            final_text = await _nanobot_agent.process_direct(
                content=message,
                session_key=session_key,
                channel="anywork",
                chat_id=session_id,
                on_progress=on_progress,
            )

            for event in pending_events:
                yield event

            if final_text:
                tool_calls = [
                    {"name": e.content, "status": "done"}
                    for e in pending_events
                    if e.type == "tool_call"
                ]
                msg_data: dict = {
                    "role": "assistant",
                    "content": final_text,
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                }
                if tool_calls:
                    msg_data["tool_calls"] = tool_calls
                _append_jsonl_message(
                    self.workspace / "sessions" / f"anywork_{session_id}.jsonl",
                    msg_data,
                )
                yield ChatEvent(type="text", content=final_text)
            else:
                yield ChatEvent(type="error", content="Agent returned empty response")

        except Exception as e:
            logger.error("nanobot error in session %s: %s", session_id, e)
            yield ChatEvent(type="error", content=str(e))
        finally:
            yield ChatEvent(type="done")

    # ── claudecode backend ───────────────────────────────────────────────────

    async def _stream_claudecode(
        self,
        session_id: str,
        message: str,
        user_id: str,
    ) -> AsyncGenerator[ChatEvent, None]:
        assert _claude_engine is not None
        try:
            async for ev in _claude_engine.chat_stream(
                session_id=session_id,
                message=message,
                user_id=user_id,
                mcp_servers=_mcp_servers or None,
            ):
                if ev["type"] == "done":
                    break
                yield ChatEvent(
                    type=ev["type"],
                    content=ev.get("content", ""),
                    metadata=ev.get("metadata", {}),
                )

                # Persist assistant text to JSONL (same format as nanobot)
                if ev["type"] == "text" and ev.get("content"):
                    _append_jsonl_message(
                        self.workspace / "sessions" / f"anywork_{session_id}.jsonl",
                        {
                            "role": "assistant",
                            "content": ev["content"],
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                        },
                    )
        except Exception as e:
            logger.error("claudecode error in session %s: %s", session_id, e)
            yield ChatEvent(type="error", content=str(e))
        finally:
            yield ChatEvent(type="done")


# ---------------------------------------------------------------------------
# Initialise bridge
# ---------------------------------------------------------------------------

bridge = AgentBridge(WORKSPACE_DIR)


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "workspace": WORKSPACE_DIR,
        "workspace_exists": Path(WORKSPACE_DIR).is_dir(),
        "engine": ENGINE,
        "model": os.environ.get("MODEL", "(auto)"),
        "skills": _skill_names,
        "mcp_servers": [s.get("name") for s in _mcp_servers],
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
    for entry in sorted(target.iterdir()):
        stat = entry.stat()
        entries.append({
            "name": entry.name,
            "type": "dir" if entry.is_dir() else "file",
            "size": stat.st_size if entry.is_file() else 0,
            "modified": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(),
        })
    return {"path": path, "entries": entries}


# ---------------------------------------------------------------------------
# Workspace file API
# ---------------------------------------------------------------------------

_WORKSPACE_FILES = {"soul": "SOUL.md", "agents": "AGENTS.md"}


class WorkspaceFileBody(BaseModel):
    content: str


@app.get("/workspace/{file}")
async def get_workspace_file(file: str):
    if file not in _WORKSPACE_FILES:
        raise HTTPException(status_code=404, detail="Unknown workspace file")
    fpath = Path(WORKSPACE_DIR) / _WORKSPACE_FILES[file]
    content = fpath.read_text(encoding="utf-8") if fpath.exists() else ""
    return {"file": file, "content": content}


@app.put("/workspace/{file}")
async def put_workspace_file(file: str, body: WorkspaceFileBody):
    if file not in _WORKSPACE_FILES:
        raise HTTPException(status_code=404, detail="Unknown workspace file")
    fpath = Path(WORKSPACE_DIR) / _WORKSPACE_FILES[file]
    fpath.write_text(body.content, encoding="utf-8")
    logger.info("Updated workspace file: %s", _WORKSPACE_FILES[file])
    return {"success": True}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _read_jsonl_messages(fpath: Path) -> list[dict]:
    """Parse a JSONL session file, returning only user/assistant messages."""
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
                if data.get("_type") == "metadata":
                    continue
                role = data.get("role")
                if role in ("user", "assistant") and data.get("content"):
                    content = data["content"]
                    if not isinstance(content, str):
                        continue
                    if role == "user" and "\n\n[Runtime Context]" in content:
                        continue
                    msg: dict = {
                        "role": role,
                        "content": content,
                        "timestamp": data.get("timestamp", ""),
                    }
                    if role == "assistant" and data.get("tool_calls"):
                        own_calls = [
                            tc for tc in data["tool_calls"]
                            if isinstance(tc.get("name"), str)
                        ]
                        if own_calls:
                            msg["tool_calls"] = own_calls
                    messages.append(msg)
    except OSError:
        pass
    return messages


def _append_jsonl_message(fpath: Path, message: dict) -> None:
    """Append a single message line to a JSONL session file."""
    try:
        fpath.parent.mkdir(parents=True, exist_ok=True)
        with open(fpath, "a", encoding="utf-8") as f:
            f.write(json.dumps(message, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning("Failed to append message to %s: %s", fpath, e)
