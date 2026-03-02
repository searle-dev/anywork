"""
Workspace initialization for AnyWork worker containers.

When a container starts, this module ensures the user's workspace
directory has the required structure and default files.
"""

import os
import logging

logger = logging.getLogger(__name__)

DEFAULT_CLAUDE_MD = """# AnyWork Workspace

You are running inside an AnyWork worker container.

## Workspace

Your workspace is mounted at /workspace. Users' files are in /workspace/files.
Conversation history is automatically saved in /workspace/sessions.

## Guidelines
- Be helpful, accurate, and concise
- When working with files, always confirm actions with the user
- Save important outputs to /workspace/files for persistence
"""

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

    # Create default CLAUDE.md if not exists (Claude Code reads this natively)
    claude_md_path = os.path.join(workspace_dir, "CLAUDE.md")
    if not os.path.exists(claude_md_path):
        with open(claude_md_path, "w") as f:
            f.write(DEFAULT_CLAUDE_MD.strip() + "\n")
        logger.info("Created default CLAUDE.md")

    logger.info("Workspace initialization complete")
