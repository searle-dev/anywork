"""
ClaudeCode Engine — runs the `claude` CLI as a subprocess and streams
results back as ChatEvent objects.

The `claude` CLI (Claude Code) is invoked with:
  claude --print <message> --output-format stream-json [flags]

Session continuity is maintained via `--resume <session-id>`, which lets
Claude Code reuse the conversation stored in ~/.claude/projects/.

Skills are injected by prepending skill prompts to the user's system
configuration.  MCP servers are passed via a temporary --mcp-config JSON
file written for each session.

Prerequisites (in the worker container):
  - `claude` CLI installed and on PATH  (npm install -g @anthropic-ai/claude-code)
  - ANTHROPIC_API_KEY set in environment
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import AsyncGenerator

from anywork_adapter.skill_loader import load_skill_prompts

logger = logging.getLogger(__name__)

_CLAUDE_BIN = shutil.which("claude") or "claude"


class ClaudeCodeEngine:
    """
    Wraps the Claude Code CLI as an async streaming engine.

    One instance per worker process.  Maintains a mapping of
    session_key → claude_session_id so conversations can be resumed.
    """

    def __init__(self, workspace_dir: str, skill_prompts: str = ""):
        self.workspace = Path(workspace_dir)
        self.skill_prompts = skill_prompts
        # Maps our session_key to the claude CLI session id (returned in stream)
        self._session_map: dict[str, str] = {}

    async def chat_stream(
        self,
        session_id: str,
        message: str,
        user_id: str,
        mcp_servers: list[dict] | None = None,
    ) -> AsyncGenerator[dict, None]:
        """
        Yield dicts with keys: type, content, metadata.
        Types: "tool_call", "text", "error", "done"
        """
        session_key = f"anywork:{session_id}"
        claude_session_id = self._session_map.get(session_key)

        mcp_config_file: str | None = None
        if mcp_servers:
            mcp_config_file = self._write_mcp_config(mcp_servers)

        cmd = self._build_command(
            message=message,
            claude_session_id=claude_session_id,
            mcp_config_file=mcp_config_file,
        )

        logger.info(
            "ClaudeCode session=%s resume=%s cmd=%s",
            session_id,
            claude_session_id or "new",
            " ".join(cmd),
        )

        try:
            async for event in self._run_and_stream(cmd, session_key):
                yield event
        finally:
            if mcp_config_file:
                try:
                    os.unlink(mcp_config_file)
                except OSError:
                    pass

    # ---------------------------------------------------------------------------
    # Internals
    # ---------------------------------------------------------------------------

    def _build_command(
        self,
        message: str,
        claude_session_id: str | None,
        mcp_config_file: str | None,
    ) -> list[str]:
        cmd = [
            _CLAUDE_BIN,
            "--print", message,
            "--output-format", "stream-json",
            "--no-interactive",
        ]

        # Resume an existing session
        if claude_session_id:
            cmd += ["--resume", claude_session_id]

        # Inject skill prompts as an additional system-prompt file
        if self.skill_prompts:
            # Write to a temp file and pass via --system-prompt flag
            # (claude CLI supports reading system prompt from a file path)
            sp_file = self._write_temp(self.skill_prompts, suffix=".md")
            cmd += ["--system-prompt", sp_file]

        # MCP configuration
        if mcp_config_file:
            cmd += ["--mcp-config", mcp_config_file]

        return cmd

    async def _run_and_stream(
        self, cmd: list[str], session_key: str
    ) -> AsyncGenerator[dict, None]:
        env = {**os.environ, "CLAUDE_WORKSPACE": str(self.workspace)}

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(self.workspace),
            env=env,
        )

        text_chunks: list[str] = []
        new_session_id: str | None = None

        assert proc.stdout is not None
        async for raw_line in proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                logger.debug("ClaudeCode non-JSON line: %s", line)
                continue

            event_type = event.get("type", "")

            # Capture session id for future resume
            if event_type in ("result", "system"):
                sid = event.get("session_id")
                if sid:
                    new_session_id = sid

            if event_type == "assistant":
                # Content blocks within an assistant message
                for block in event.get("message", {}).get("content", []):
                    if block.get("type") == "text":
                        text_chunks.append(block["text"])
                    elif block.get("type") == "tool_use":
                        yield {
                            "type": "tool_call",
                            "content": block.get("name", "tool"),
                            "metadata": {"input": block.get("input", {})},
                        }

            elif event_type == "result":
                # Final result message
                result_text = event.get("result", "")
                if result_text:
                    text_chunks.append(result_text)

        await proc.wait()
        if proc.returncode != 0:
            stderr = b""
            if proc.stderr:
                stderr = await proc.stderr.read()
            err_msg = stderr.decode("utf-8", errors="replace").strip() or (
                f"claude exited with code {proc.returncode}"
            )
            yield {"type": "error", "content": err_msg, "metadata": {}}
        else:
            full_text = "".join(text_chunks).strip()
            if full_text:
                yield {"type": "text", "content": full_text, "metadata": {}}

        # Persist session id for resume
        if new_session_id:
            self._session_map[session_key] = new_session_id

        yield {"type": "done", "content": "", "metadata": {}}

    @staticmethod
    def _write_temp(content: str, suffix: str = "") -> str:
        fd, path = tempfile.mkstemp(suffix=suffix)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
        except Exception:
            os.close(fd)
            raise
        return path

    @staticmethod
    def _write_mcp_config(mcp_servers: list[dict]) -> str:
        """
        Serialise MCP server configs to a JSON file understood by claude CLI.

        Input format (from WorkerSpec MCPServerConfig):
          [{"name":"github","transport":"stdio","command":"npx","args":[...],"env":{}}]

        Claude CLI mcp-config format:
          {"mcpServers": {"github": {"command":"npx","args":[...],"env":{}}}}
        """
        mcp_dict: dict = {}
        for srv in mcp_servers:
            name = srv.get("name", "unknown")
            transport = srv.get("transport", "stdio")
            if transport == "stdio":
                entry: dict = {
                    "command": srv.get("command", ""),
                    "args": srv.get("args", []),
                }
                if srv.get("env"):
                    entry["env"] = srv["env"]
            else:  # sse
                entry = {
                    "url": srv.get("url", ""),
                }
                if srv.get("env"):
                    entry["env"] = srv["env"]
            mcp_dict[name] = entry

        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"mcpServers": mcp_dict}, f)
        except Exception:
            os.close(fd)
            raise
        return path
