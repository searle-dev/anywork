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
                # nanobot only persists user messages to JSONL; append assistant reply ourselves
                _append_jsonl_message(
                    self.workspace / "sessions" / f"anywork_{session_id}.jsonl",
                    {"role": "assistant", "content": final_text,
                     "timestamp": datetime.now(timezone.utc).isoformat()},
                )
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
                if data.get("_type") == "metadata":
                    continue
                role = data.get("role")
                if role in ("user", "assistant") and data.get("content"):
                    content = data["content"]
                    # Strip nanobot's injected [Runtime Context] from user messages
                    if role == "user" and "\n\n[Runtime Context]" in content:
                        content = content.split("\n\n[Runtime Context]")[0]
                    messages.append({
                        "role": role,
                        "content": content,
                        "timestamp": data.get("timestamp", ""),
                    })
    except OSError:
        pass
    return messages


def _append_jsonl_message(fpath: Path, message: dict) -> None:
    """Append a single message line to a nanobot JSONL session file."""
    try:
        with open(fpath, "a", encoding="utf-8") as f:
            f.write(json.dumps(message, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning("Failed to append message to %s: %s", fpath, e)


