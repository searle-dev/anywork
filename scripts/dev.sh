#!/bin/bash
# AnyWork Local Development - start without Docker
# Useful for rapid iteration on individual services

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== AnyWork Dev Mode ==="
echo ""

# Check for .env
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  echo "Please edit .env and set your API keys, then re-run."
  exit 1
fi

source .env

# ── Local dev overrides ────────────────────────────────
DATA_DIR="$ROOT_DIR/data"
mkdir -p "$DATA_DIR" "$DATA_DIR/workspace"

export DB_DIR="$DATA_DIR"
export WORKSPACE_DIR="$DATA_DIR/workspace"
export STATIC_WORKER_URL="http://localhost:${WORKER_PORT:-8080}"
export CONTAINER_DRIVER="${CONTAINER_DRIVER:-static}"

# macOS AirPlay Receiver occupies port 7000; default to 7001
WEB_PORT="${WEB_PORT:-7001}"

# ── Check dependencies ─────────────────────────────────
if [ ! -d "web/node_modules" ]; then
  echo "[SETUP] Installing web dependencies..."
  (cd web && npm install)
fi
if [ ! -d "server/node_modules" ]; then
  echo "[SETUP] Installing server dependencies..."
  (cd server && npm install)
fi

# ── Start services ─────────────────────────────────────
echo "[1/3] Starting Worker..."
(cd worker && python -m anywork_adapter.main) &
WORKER_PID=$!

sleep 3

echo "[2/3] Starting Server..."
(cd server && npm run dev) &
SERVER_PID=$!

sleep 2

echo "[3/3] Starting Web..."
(cd web && npx next dev --port "$WEB_PORT") &
WEB_PID=$!

echo ""
echo "==================================="
echo "  AnyWork is running!"
echo "  Web:    http://localhost:$WEB_PORT"
echo "  Server: http://localhost:${SERVER_PORT:-3001}"
echo "  Worker: http://localhost:${WORKER_PORT:-8080}"
echo "==================================="
echo "Press Ctrl+C to stop all services"

# Cleanup on exit
trap "kill $WORKER_PID $SERVER_PID $WEB_PID 2>/dev/null; exit" INT TERM
wait
