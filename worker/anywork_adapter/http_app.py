"""
FastAPI application for AnyWork Worker.

Endpoints:
  POST /prepare  — Write skills and .mcp.json to workspace
  POST /chat     — Execute a task via ClaudeSDKClient, return SSE stream
  POST /cancel   — Interrupt the current task
  GET  /health   — Health check
  GET  /sessions — List sessions (backward compat)
  GET  /sessions/{session_id} — Get session history (backward compat)
  GET  /workspace/{file} — Read workspace file
  PUT  /workspace/{file} — Update workspace file
"""
from __future__ import annotations

import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel

from .executor import SessionExecutor

logger = logging.getLogger(__name__)

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")

app = FastAPI(title="AnyWork Worker", version="0.2.0")

# Session executors: session_id → SessionExecutor
executors: dict[str, SessionExecutor] = {}


# ── Models ──────────────────────────────────────────────────

class SkillFile(BaseModel):
    name: str
    files: dict[str, str]  # filename → content


class PrepareRequest(BaseModel):
    task_id: str | None = None
    skills: list[SkillFile] = []
    mcp_servers: dict[str, Any] = {}


class ChatRequest(BaseModel):
    session_id: str
    message: str


class CancelRequest(BaseModel):
    session_id: str


# ── Endpoints ───────────────────────────────────────────────

@app.post("/prepare")
async def prepare(request: PrepareRequest):
    """Prepare skills and MCP config for the next task."""
    skills_dir = Path(WORKSPACE_DIR) / "skills"

    # Clean non-local skills
    if skills_dir.exists():
        for item in skills_dir.iterdir():
            if item.is_dir() and not item.name.startswith(".local-"):
                shutil.rmtree(item)

    # Write new skills
    skills_dir.mkdir(parents=True, exist_ok=True)
    for skill in request.skills:
        skill_dir = skills_dir / skill.name
        skill_dir.mkdir(parents=True, exist_ok=True)
        for filename, content in skill.files.items():
            file_path = skill_dir / filename
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)

    # Write .mcp.json
    if request.mcp_servers:
        mcp_config = {"mcpServers": request.mcp_servers}
        (Path(WORKSPACE_DIR) / ".mcp.json").write_text(json.dumps(mcp_config, indent=2))
    else:
        mcp_path = Path(WORKSPACE_DIR) / ".mcp.json"
        if mcp_path.exists():
            mcp_path.unlink()

    logger.info(
        f"Prepared: {len(request.skills)} skills, "
        f"{len(request.mcp_servers)} MCP servers"
    )
    return {"status": "ready"}


@app.post("/chat")
async def chat(request: ChatRequest):
    """Execute a task, return SSE stream."""
    executor = await _get_or_create_executor(request.session_id)

    async def stream():
        try:
            async for event in executor.execute_task(request.message):
                yield f"event: {event['event']}\ndata: {json.dumps(event['data'])}\n\n"
        except Exception as e:
            logger.error(f"Chat error: {e}", exc_info=True)
            error_data = json.dumps({"content": str(e), "metadata": {}})
            yield f"event: error\ndata: {error_data}\n\n"
            done_data = json.dumps({"content": "", "metadata": {}})
            yield f"event: done\ndata: {done_data}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/cancel")
async def cancel(request: CancelRequest):
    """Cancel the currently running task for a session."""
    executor = executors.get(request.session_id)
    if executor:
        await executor.cancel()
    return {"status": "canceled"}


@app.get("/health")
async def health():
    """Health check."""
    return {
        "status": "ok",
        "engine": "claude-agent-sdk",
        "workspace": WORKSPACE_DIR,
        "active_sessions": len(executors),
    }


# ── Backward-compatible endpoints ───────────────────────────

@app.get("/sessions")
async def list_sessions():
    """List conversation sessions (from JSONL files)."""
    sessions_dir = Path(WORKSPACE_DIR) / "sessions"
    sessions = []
    if sessions_dir.exists():
        for f in sessions_dir.glob("*.jsonl"):
            sessions.append({
                "session_id": f.stem.removeprefix("anywork_"),
                "file": f.name,
            })
    return {"sessions": sessions}


@app.get("/sessions/{session_id}")
async def get_session(session_id: str):
    """Get message history for a session."""
    sessions_dir = Path(WORKSPACE_DIR) / "sessions"

    # Try multiple file patterns
    for pattern in [f"anywork_{session_id}.jsonl", f"{session_id}.jsonl"]:
        fpath = sessions_dir / pattern
        if fpath.exists():
            messages = []
            for line in fpath.read_text().strip().splitlines():
                if line.strip():
                    try:
                        messages.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            return {"session_id": session_id, "messages": messages}

    return JSONResponse({"session_id": session_id, "messages": []}, status_code=404)


@app.get("/workspace/{file}")
async def get_workspace_file(file: str):
    """Read a workspace file (soul, agents)."""
    file_map = {"soul": "SOUL.md", "agents": "AGENTS.md"}
    filename = file_map.get(file, file)
    fpath = Path(WORKSPACE_DIR) / filename

    if not fpath.exists():
        return JSONResponse({"file": filename, "content": ""}, status_code=404)

    return {"file": filename, "content": fpath.read_text()}


@app.put("/workspace/{file}")
async def put_workspace_file(file: str, body: dict[str, Any]):
    """Update a workspace file."""
    file_map = {"soul": "SOUL.md", "agents": "AGENTS.md"}
    filename = file_map.get(file, file)
    fpath = Path(WORKSPACE_DIR) / filename

    content = body.get("content", "")
    fpath.write_text(content)
    return {"success": True}


# ── Helpers ─────────────────────────────────────────────────

async def _get_or_create_executor(session_id: str) -> SessionExecutor:
    """Get existing executor for session or create a new one."""
    if session_id in executors:
        return executors[session_id]

    executor = SessionExecutor(session_id)
    await executor.connect()
    executors[session_id] = executor
    return executor
