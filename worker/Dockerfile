FROM python:3.12-slim-bookworm

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl && \
    rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml README.md ./
RUN pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir \
    "nanobot-ai>=0.1.4" \
    "fastapi>=0.115.0" \
    "uvicorn[standard]>=0.32.0" \
    "sse-starlette>=2.0.0" \
    "pydantic>=2.0.0" \
    "openai>=1.60.0" \
    "anthropic>=0.42.0"

# Copy application code
COPY anywork_adapter/ ./anywork_adapter/

# Create default workspace
RUN mkdir -p /workspace

ENV WORKSPACE_DIR=/workspace
ENV WORKER_PORT=8080

EXPOSE 8080

CMD ["python", "-m", "anywork_adapter.main"]
