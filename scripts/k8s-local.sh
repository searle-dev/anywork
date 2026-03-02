#!/usr/bin/env bash
# ------------------------------------------------------------------
# k8s-local.sh — One-shot script to run AnyWork on a local k3d cluster
#
# Prerequisites: Docker running, .env file with API keys
# Installs: k3d, kubectl (via Homebrew on macOS)
#
# Usage:
#   bash scripts/k8s-local.sh          # full setup
#   bash scripts/k8s-local.sh teardown  # destroy cluster
# ------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER_NAME="anywork"
NAMESPACE="anywork"
SERVER_PORT=3001
WEB_PORT=7001

# ── Colors ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ── Teardown ───────────────────────────────────────────────
if [[ "${1:-}" == "teardown" ]]; then
  info "Tearing down k3d cluster '$CLUSTER_NAME'..."
  k3d cluster delete "$CLUSTER_NAME" 2>/dev/null || true
  ok "Cluster deleted."
  exit 0
fi

# ── 1. Check / install dependencies ───────────────────────
check_or_install() {
  local cmd="$1" pkg="${2:-$1}"
  if ! command -v "$cmd" &>/dev/null; then
    warn "$cmd not found, installing via Homebrew..."
    if ! command -v brew &>/dev/null; then
      err "Homebrew not found. Install $cmd manually or install Homebrew first."
    fi
    brew install "$pkg"
  fi
  ok "$cmd $(command -v "$cmd")"
}

info "Checking dependencies..."
check_or_install docker
check_or_install k3d
check_or_install kubectl

if ! docker info &>/dev/null; then
  err "Docker daemon is not running. Start Docker Desktop first."
fi

# ── 2. Create k3d cluster ─────────────────────────────────
if k3d cluster list 2>/dev/null | grep -q "$CLUSTER_NAME"; then
  warn "Cluster '$CLUSTER_NAME' already exists — reusing."
else
  info "Creating k3d cluster '$CLUSTER_NAME'..."
  k3d cluster create "$CLUSTER_NAME" \
    --port "${SERVER_PORT}:${SERVER_PORT}@server:0" \
    --k3s-arg "--disable=traefik@server:0"
  ok "Cluster created."
fi

kubectl config use-context "k3d-${CLUSTER_NAME}"
ok "kubectl context set to k3d-${CLUSTER_NAME}"

# ── 3. Build Docker images (parallel) ─────────────────────
info "Building server and worker images in parallel..."
docker build -t anywork-server:latest server/ &
BUILD_SERVER_PID=$!
docker build -t anywork-worker:latest worker/ &
BUILD_WORKER_PID=$!

wait "$BUILD_SERVER_PID" || err "Server image build failed"
wait "$BUILD_WORKER_PID" || err "Worker image build failed"

ok "Images built."

# ── 4. Import images into k3d ─────────────────────────────
info "Importing images into k3d..."
k3d image import anywork-server:latest anywork-worker:latest -c "$CLUSTER_NAME"
ok "Images imported."

# ── 5. Apply K8s manifests ─────────────────────────────────
info "Applying K8s manifests..."
kubectl apply -k deploy/k8s/
ok "Manifests applied."

# ── 6. Patch secrets from .env ─────────────────────────────
if [[ -f .env ]]; then
  info "Patching secrets from .env..."

  # Source .env (handle comments and empty lines)
  set -a
  # shellcheck disable=SC1091
  source <(grep -E '^[A-Z_]+=.+' .env | sed 's/#.*//')
  set +a

  # Build --from-literal flags for safe secret creation (handles special chars)
  LITERAL_FLAGS=()
  for key in ANTHROPIC_API_KEY API_KEY API_BASE_URL; do
    val="${!key:-}"
    if [[ -n "$val" ]]; then
      LITERAL_FLAGS+=("--from-literal=${key}=${val}")
    fi
  done

  if [[ ${#LITERAL_FLAGS[@]} -gt 0 ]]; then
    kubectl create secret generic anywork-secrets -n "$NAMESPACE" \
      "${LITERAL_FLAGS[@]}" --dry-run=client -o yaml | kubectl apply -f -
    ok "Secrets patched."
  else
    warn "No API keys found in .env — secrets not patched."
  fi
else
  warn ".env not found — secrets not patched. Fill them manually:"
  warn "  kubectl edit secret anywork-secrets -n $NAMESPACE"
fi

# ── 7. Restart server to pick up secrets ───────────────────
kubectl rollout restart deployment/anywork-server -n "$NAMESPACE"
info "Waiting for server to be ready..."
kubectl rollout status deployment/anywork-server -n "$NAMESPACE" --timeout=120s
ok "Server is running."

# ── 8. Port-forward ────────────────────────────────────────
info "Starting port-forward (server → localhost:${SERVER_PORT})..."
kubectl port-forward -n "$NAMESPACE" svc/anywork-server "${SERVER_PORT}:${SERVER_PORT}" &
PF_PID=$!
sleep 2

# Verify port-forward is alive
if ! kill -0 "$PF_PID" 2>/dev/null; then
  err "Port-forward failed. Check: kubectl get pods -n $NAMESPACE"
fi

# ── 9. Start web dev server ───────────────────────────────
info "Starting web dev server on port ${WEB_PORT}..."
(cd web && NEXT_PUBLIC_API_URL="http://localhost:${SERVER_PORT}" \
           NEXT_PUBLIC_WS_URL="ws://localhost:${SERVER_PORT}/ws" \
           npx next dev --port "$WEB_PORT") &
WEB_PID=$!

# ── Cleanup on exit ───────────────────────────────────────
cleanup() {
  info "Shutting down..."
  kill "$PF_PID" 2>/dev/null || true
  kill "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# ── Done ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  AnyWork K8s Local Environment Ready!${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Web UI:   ${BLUE}http://localhost:${WEB_PORT}${NC}"
echo -e "  API:      ${BLUE}http://localhost:${SERVER_PORT}${NC}"
echo -e "  Driver:   ${YELLOW}k8s${NC} (per-session Pods)"
echo ""
echo -e "  ${YELLOW}Useful commands:${NC}"
echo -e "    kubectl get pods -n $NAMESPACE          # list pods"
echo -e "    kubectl logs -n $NAMESPACE -l app=anywork-server -f  # server logs"
echo -e "    kubectl logs -n $NAMESPACE -l app=anywork-worker -f  # worker logs"
echo -e "    bash scripts/k8s-local.sh teardown      # destroy cluster"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop port-forward and web server."
echo ""

# Wait for background processes
wait
