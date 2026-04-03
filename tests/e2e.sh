#!/usr/bin/env bash
set -uo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0

pass() { echo -e "  ${GREEN}PASS${NC}: $1"; ((PASS++)); }
fail() { echo -e "  ${RED}FAIL${NC}: $1"; ((FAIL++)); }

TMPDIR=$(mktemp -d)
ROUTER_PID=""
CHANNEL_PID=""
CONTAINER_ID=""

cleanup() {
  echo ""
  echo "--- Cleanup ---"
  [ -n "$CHANNEL_PID" ] && kill "$CHANNEL_PID" 2>/dev/null || true
  [ -n "$ROUTER_PID" ] && kill "$ROUTER_PID" 2>/dev/null || true
  sleep 0.5
  [ -n "$CONTAINER_ID" ] && docker rm -f "$CONTAINER_ID" >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
  echo -e "${BOLD}Results: ${GREEN}$PASS passed${NC}, ${RED}$FAIL failed${NC}"
  [ "$FAIL" -eq 0 ] || exit 1
}
trap cleanup EXIT

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ============================================
echo -e "${BOLD}=== Part 1: hh init ===${NC}"
# ============================================

INIT_DIR="$TMPDIR/init-test"
mkdir -p "$INIT_DIR"

(cd "$INIT_DIR" && npx tsx "$REPO_ROOT/src/cli.ts" init --slug e2e/test --router-url http://127.0.0.1:9876) >/dev/null 2>&1

if [ -f "$INIT_DIR/.mcp.json" ]; then pass ".mcp.json created"; else fail ".mcp.json created"; fi
if [ -f "$INIT_DIR/.hookherald.json" ]; then pass ".hookherald.json created"; else fail ".hookherald.json created"; fi
if grep -q "webhook-channel" "$INIT_DIR/.mcp.json" 2>/dev/null; then pass ".mcp.json contains webhook-channel"; else fail ".mcp.json contains webhook-channel"; fi
if grep -q "e2e/test" "$INIT_DIR/.hookherald.json" 2>/dev/null; then pass ".hookherald.json contains slug"; else fail ".hookherald.json contains slug"; fi
if grep -q "9876" "$INIT_DIR/.hookherald.json" 2>/dev/null; then pass ".hookherald.json contains router URL"; else fail ".hookherald.json contains router URL"; fi

# ============================================
echo -e "${BOLD}=== Part 2: Full Lifecycle ===${NC}"
# ============================================

ROUTER_LOG="$TMPDIR/router.log"
ROUTER_PORT=0 npx tsx src/webhook-router.ts 2>"$ROUTER_LOG" >/dev/null &
ROUTER_PID=$!

# Wait for port assignment
PORT=""
for _ in $(seq 1 50); do
  PORT=$(grep -oP 'HOOKHERALD_PORT=\K\d+' "$ROUTER_LOG" 2>/dev/null || true)
  [ -n "$PORT" ] && break
  sleep 0.1
done

if [ -z "$PORT" ]; then
  echo "  Router did not start (no port found in log)"
  exit 1
fi

ROUTER_URL="http://127.0.0.1:$PORT"

if curl -sf "$ROUTER_URL/api/health" -o /dev/null 2>/dev/null; then pass "Router /api/health returns 200"; else fail "Router /api/health returns 200"; fi

# Start channel (sleep keeps stdin open so MCP transport doesn't close)
CHANNEL_LOG="$TMPDIR/channel.log"
export PROJECT_SLUG="e2e/test"
export ROUTER_URL="$ROUTER_URL"
export HH_HEARTBEAT_MS=2000
(sleep 300 | npx tsx src/webhook-channel.ts >/dev/null 2>"$CHANNEL_LOG") &
CHANNEL_PID=$!

# Wait for channel to register
REGISTERED=false
for _ in $(seq 1 50); do
  SESSIONS=$(curl -sf "$ROUTER_URL/api/sessions" 2>/dev/null || echo "[]")
  if echo "$SESSIONS" | grep -q "e2e/test"; then
    REGISTERED=true; break
  fi
  sleep 0.1
done
if [ "$REGISTERED" = true ]; then pass "Channel registered with router"; else fail "Channel registered with router"; fi

# Send webhook
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "$ROUTER_URL/" \
  -H "Content-Type: application/json" \
  -d '{"project_slug":"e2e/test","message":"hello from e2e"}')
if [ "$HTTP_CODE" = "200" ]; then pass "Webhook POST returns 200"; else fail "Webhook POST returns 200 (got $HTTP_CODE)"; fi

# Verify event recorded
EVENTS=$(curl -sf "$ROUTER_URL/api/events?slug=e2e/test" 2>/dev/null || echo "[]")
if echo "$EVENTS" | grep -q "e2e/test"; then pass "Event recorded in router"; else fail "Event recorded in router"; fi

# Kill channel via API and verify session removed
KILL_CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$ROUTER_URL/api/kill" \
  -H "Content-Type: application/json" \
  -d '{"project_slug":"e2e/test"}')
if [ "$KILL_CODE" = "200" ]; then pass "hh kill returns 200"; else fail "hh kill returns 200 (got $KILL_CODE)"; fi

SESSIONS_AFTER=$(curl -sf "$ROUTER_URL/api/sessions" 2>/dev/null || echo "[]")
if [ "$SESSIONS_AFTER" = "[]" ]; then pass "Session removed after kill"; else fail "Session removed after kill"; fi

# Clean up channel subshell (don't wait — sleep 300 may linger, cleanup trap handles it)
kill "$CHANNEL_PID" 2>/dev/null || true
CHANNEL_PID=""

# Kill router
kill "$ROUTER_PID" 2>/dev/null || true
wait "$ROUTER_PID" 2>/dev/null || true
ROUTER_PID=""

# ============================================
echo -e "${BOLD}=== Part 3: Docker Smoke Test ===${NC}"
# ============================================

# Skip if docker is not available
if ! command -v docker >/dev/null 2>&1; then
  echo "  SKIP: docker not available"
else
  docker build -t hookherald:e2e-test . >/dev/null 2>&1

  CONTAINER_ID=$(docker run -d -e ROUTER_PORT=9876 -e ROUTER_HOST=0.0.0.0 \
    -p 9876:9876 hookherald:e2e-test)

  DOCKER_READY=false
  for _ in $(seq 1 50); do
    if curl -sf http://127.0.0.1:9876/api/health -o /dev/null 2>/dev/null; then
      DOCKER_READY=true; break
    fi
    sleep 0.2
  done
  if [ "$DOCKER_READY" = true ]; then pass "Docker container /api/health returns 200"; else fail "Docker container /api/health returns 200"; fi

  HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST http://127.0.0.1:9876/ \
    -H "Content-Type: application/json" \
    -d '{"project_slug":"docker/test","message":"docker smoke"}')
  if [ "$HTTP_CODE" = "404" ]; then pass "Docker webhook returns 404 (no channel)"; else fail "Docker webhook returns 404 (got $HTTP_CODE)"; fi

  docker rm -f "$CONTAINER_ID" >/dev/null 2>&1
  CONTAINER_ID=""
fi

echo ""
echo -e "${BOLD}=== Done ===${NC}"
