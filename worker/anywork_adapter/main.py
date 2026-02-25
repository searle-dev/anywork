"""
AnyWork Worker entry point.

Initializes the workspace and starts the HTTP/SSE server.
"""

import logging
import os
import sys

import uvicorn

from .workspace_init import init_workspace

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("anywork-worker")


def main():
    workspace_dir = os.environ.get("WORKSPACE_DIR", "/workspace")
    port = int(os.environ.get("WORKER_PORT", "8080"))

    # Initialize workspace on startup
    init_workspace(workspace_dir)

    logger.info(f"Starting AnyWork Worker on port {port}")
    logger.info(f"Workspace: {workspace_dir}")

    uvicorn.run(
        "anywork_adapter.http_channel:app",
        host="0.0.0.0",
        port=port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
