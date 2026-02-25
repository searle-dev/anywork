"""
Workspace initialization for AnyWork worker containers.

When a container starts, this module ensures the user's workspace
directory has the required structure and default files.
"""

import os
import logging

logger = logging.getLogger(__name__)

DEFAULT_SOUL = """# AnyWork Agent

You are AnyWork, a helpful AI assistant running in a secure containerized environment.

## Capabilities
- Read and write files in the workspace
- Execute shell commands (sandboxed)
- Search the web for information
- Run code and scripts
- Help with coding, writing, analysis, and more

## Workspace
Your workspace is mounted at /workspace. Users' files are in /workspace/files.
Conversation history is automatically saved in /workspace/sessions.

## Guidelines
- Be helpful, accurate, and concise
- When working with files, always confirm actions with the user
- Save important outputs to /workspace/files for persistence
"""

DEFAULT_AGENTS = (
    "# AnyWork Agent Capabilities\n"
    "\n"
    "## Available Tools\n"
    "\n"
    "- **read_file / write_file / edit_file / list_dir** — Read and write files in the workspace\n"
    "- **exec** — Run shell commands (sandboxed to workspace)\n"
    "- **web_fetch** — Fetch and read content from a URL\n"
    "- **web_search** — Search the web via Brave Search (if configured)\n"
    "- **message** — Send follow-up messages to the user\n"
    "\n"
    "## Workspace Layout\n"
    "\n"
    "```\n"
    "/workspace/\n"
    "├── SOUL.md       # Your personality and style\n"
    "├── AGENTS.md     # This file — capabilities reference\n"
    "├── sessions/     # Conversation history (managed automatically)\n"
    "└── files/        # User files and agent outputs\n"
    "```\n"
    "\n"
    "## Guidelines\n"
    "\n"
    "- Save important outputs to /workspace/files/ so they persist\n"
    "- Use exec for computation, not for network calls outside the workspace\n"
    "- Prefer edit_file over write_file when modifying existing files\n"
)

WORKSPACE_STRUCTURE = {
    "sessions": "Conversation history",
    "files": "User files and outputs",
    "skills": "Custom agent skills",
}


def init_workspace(workspace_dir: str) -> None:
    """
    Initialize the workspace directory structure.

    Creates required subdirectories and default config files
    if they don't already exist.
    """
    logger.info(f"Initializing workspace: {workspace_dir}")

    # Create base directory
    os.makedirs(workspace_dir, exist_ok=True)

    # Create subdirectories
    for dirname, description in WORKSPACE_STRUCTURE.items():
        dirpath = os.path.join(workspace_dir, dirname)
        os.makedirs(dirpath, exist_ok=True)
        logger.debug(f"  {dirname}/ - {description}")

    # Create default SOUL.md if not exists
    soul_path = os.path.join(workspace_dir, "SOUL.md")
    if not os.path.exists(soul_path):
        with open(soul_path, "w") as f:
            f.write(DEFAULT_SOUL.strip() + "\n")
        logger.info("Created default SOUL.md")

    # Create default AGENTS.md if not exists
    agents_path = os.path.join(workspace_dir, "AGENTS.md")
    if not os.path.exists(agents_path):
        with open(agents_path, "w") as f:
            f.write(DEFAULT_AGENTS.strip() + "\n")
        logger.info("Created default AGENTS.md")

    logger.info("Workspace initialization complete")
