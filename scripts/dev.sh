#!/bin/bash
# AnyWork Local Development - start without Docker
# Useful for rapid iteration on individual services

set -e

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

# Terminal 1: Worker
echo "[1/3] Starting Worker..."
(cd worker && WORKSPACE_DIR=../data/workspace python -m anywork_adapter.main) &
WORKER_PID=$!

sleep 3

# Terminal 2: Server
echo "[2/3] Starting Server..."
(cd server && npm run dev) &
SERVER_PID=$!

sleep 2

# Terminal 3: Web
echo "[3/3] Starting Web..."
(cd web && npm run dev) &
WEB_PID=$!

echo ""
echo "==================================="
echo "  AnyWork is running!"
echo "  Web:    http://localhost:7000"
echo "  Server: http://localhost:3001"
echo "  Worker: http://localhost:8080"
echo "==================================="
echo "Press Ctrl+C to stop all services"

# Cleanup on exit
trap "kill $WORKER_PID $SERVER_PID $WEB_PID 2>/dev/null; exit" INT TERM
wait
