FROM node:22-slim AS node-base

# Pre-install Claude CLI in the node stage so npm/npx are intact
RUN npm install -g @anthropic-ai/claude-code

FROM python:3.12-slim-bookworm

WORKDIR /app

# Copy entire Node.js runtime + globally installed packages (including claude CLI)
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/bin/npx /usr/local/bin/npx
COPY --from=node-base /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node-base /usr/local/bin/claude /usr/local/bin/claude
COPY --from=node-base /usr/local/lib/node_modules /usr/local/lib/node_modules

# Install system dependencies (git for skills, curl for health checks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml README.md ./
RUN pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir \
    "claude-agent-sdk>=0.1.30" \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.32.0" \
    "sse-starlette>=2.0.0" \
    "pydantic>=2.0.0"

# Copy application code
COPY anywork_adapter/ ./anywork_adapter/

# Create non-root user (Claude CLI refuses bypassPermissions as root)
RUN useradd -m -s /bin/bash worker && \
    mkdir -p /workspace && \
    chown -R worker:worker /workspace /app

USER worker

ENV WORKSPACE_DIR=/workspace
ENV WORKER_PORT=8080

EXPOSE 8080

CMD ["python", "-m", "anywork_adapter.main"]
