"""
Session executor — manages ClaudeSDKClient lifecycle per session.

One Session = one ClaudeSDKClient instance.
One Task = one client.query() call.
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, AsyncIterator

from claude_agent_sdk import (
    ClaudeSDKClient,
    ClaudeAgentOptions,
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ToolUseBlock,
)

logger = logging.getLogger(__name__)


def _build_options() -> ClaudeAgentOptions:
    """Build ClaudeAgentOptions from environment and workspace config."""
    workspace = os.environ.get("WORKSPACE_DIR", "/workspace")

    # MCP servers: read from .mcp.json if written by /prepare
    mcp_servers: dict[str, Any] = {}
    mcp_path = Path(workspace) / ".mcp.json"
    if mcp_path.exists():
        try:
            cfg = json.loads(mcp_path.read_text())
            mcp_servers = cfg.get("mcpServers", {})
        except Exception as e:
            logger.warning(f"Failed to read .mcp.json: {e}")

    model = os.environ.get("MODEL") or os.environ.get("DEFAULT_MODEL")

    opts = ClaudeAgentOptions(
        cwd=workspace,
        permission_mode="bypassPermissions",
        include_partial_messages=True,
        system_prompt={"type": "preset", "preset": "claude_code"},
        setting_sources=["project"],
    )

    if model:
        opts.model = model
    if mcp_servers:
        opts.mcp_servers = mcp_servers

    return opts


class SessionExecutor:
    """Manages a ClaudeSDKClient for a single session's lifecycle."""

    def __init__(self, session_id: str):
        self.session_id = session_id
        self.options = _build_options()
        self.client: ClaudeSDKClient | None = None
        self._connected = False

    async def connect(self) -> None:
        """Connect the ClaudeSDKClient."""
        if self._connected:
            return
        # Unset CLAUDECODE to avoid nested-session detection when running
        # inside a Claude Code parent (e.g. local dev launched from Claude Code).
        os.environ.pop("CLAUDECODE", None)
        self.client = ClaudeSDKClient(options=self.options)
        await self.client.connect()
        self._connected = True
        logger.info(f"[Session {self.session_id}] ClaudeSDKClient connected")

    async def execute_task(self, message: str) -> AsyncIterator[dict[str, Any]]:
        """Execute a task (one query), yielding SSE-formatted events."""
        if not self.client or not self._connected:
            await self.connect()

        assert self.client is not None

        await self.client.query(message)

        async for msg in self.client.receive_response():
            for event in _msg_to_sse_events(msg):
                yield event

    async def cancel(self) -> None:
        """Interrupt the current task."""
        if self.client and self._connected:
            try:
                await self.client.interrupt()
                logger.info(f"[Session {self.session_id}] Task interrupted")
            except Exception as e:
                logger.warning(f"[Session {self.session_id}] Interrupt failed: {e}")

    async def disconnect(self) -> None:
        """Disconnect and clean up."""
        if self.client and self._connected:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self._connected = False
            logger.info(f"[Session {self.session_id}] Disconnected")


def _msg_to_sse_events(msg: Any) -> list[dict[str, Any]]:
    """Convert a Claude SDK message to SSE event dicts."""
    events: list[dict[str, Any]] = []

    if isinstance(msg, AssistantMessage):
        for block in msg.content:
            if isinstance(block, TextBlock):
                events.append({
                    "event": "text",
                    "data": {"content": block.text, "metadata": {}},
                })
            elif isinstance(block, ToolUseBlock):
                events.append({
                    "event": "tool_call",
                    "data": {
                        "content": block.name,
                        "metadata": {"tool_id": block.id, "input": block.input},
                    },
                })
    elif isinstance(msg, ResultMessage):
        if msg.subtype == "success":
            events.append({
                "event": "done",
                "data": {
                    "content": "",
                    "metadata": {
                        "result": msg.result,
                        "cost_usd": msg.total_cost_usd,
                        "num_turns": msg.num_turns,
                        "duration_ms": msg.duration_ms,
                    },
                },
            })
        else:
            error_text = "; ".join(msg.errors) if hasattr(msg, "errors") else str(msg.subtype)
            events.append({
                "event": "error",
                "data": {"content": error_text, "metadata": {}},
            })
    # Other message types (system, tool_progress, etc.) are logged but not streamed
    else:
        msg_type = getattr(msg, "type", type(msg).__name__)
        logger.debug(f"SDK message type={msg_type} (not streamed)")

    return events
