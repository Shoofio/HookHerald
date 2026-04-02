# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HookHerald — a webhook relay that receives arbitrary webhook payloads, routes them by project slug to downstream channel servers, and surfaces them as MCP channel notifications for Claude Code.

## Why This Exists

Claude Code has a feature called **message channels** (research preview, shipped March 2025). Channels let external systems push one-way notifications into a running Claude Code session via MCP. A channel server declares the `claude/channel` capability, connects over stdio, and emits `notifications/claude/channel` events — Claude sees these as `<channel source="...">` messages in the conversation.

HookHerald is a general-purpose webhook-to-channel bridge. Any system that can fire an HTTP POST — CI pipelines, monitoring alerts, deployment hooks, chat bots, cron jobs — can push notifications into a running Claude Code session. The router and channel are payload-agnostic: the only required field is `project_slug` for routing. Everything else passes through as raw JSON.

The setup: each Claude Code session spawns a webhook channel server as an MCP subprocess (configured in `.mcp.json`). The channel auto-registers with a central router and maintains a heartbeat (every 30s) to survive router restarts. External systems post webhook events to the router, which forwards them to the right channel based on project slug. Multiple sessions can run in parallel, each handling different projects.

## Quick Start

```bash
# 1. Build the CLI
go build -ldflags "-X main.projectRoot=$(pwd)" -o hh ./cmd/hh/

# 2. Start the router
hh router

# 3. In any project directory, set up the MCP channel
cd ~/my-project
hh init

# 4. Start Claude Code with the channel
claude --dangerously-load-development-channels server:webhook-channel

# 5. Send a webhook
curl -X POST http://127.0.0.1:9000/ \
  -H "Content-Type: application/json" \
  -H "X-Gitlab-Token: dev-secret" \
  -d '{"project_slug":"my/project","whatever":"you want"}'
```

## Commands

```bash
# CLI (Go binary)
hh init [--slug <s>] [--router-url <u>]   # Set up .mcp.json in current directory
hh status [--router-url <u>]               # Show active sessions
hh kill <slug> [--router-url <u>]          # Bounce a session (Claude Code respawns it)
hh router [--port <p>] [--secret <s>]      # Start the webhook router

# Node (development)
npm run router          # Start the webhook router (default port 9000)
npm run channel         # Start an MCP channel server
npm test                # Run all test suites (observability, channel, router, cli)

# Build CLI
go build -ldflags "-X main.projectRoot=$(pwd)" -o hh ./cmd/hh/

# Run a single test suite
npx tsx --test-force-exit --test tests/observability.test.ts
npx tsx --test-force-exit --test tests/channel.test.ts
npx tsx --test-force-exit --test tests/router.test.ts
npx tsx --test-force-exit --test tests/cli.test.ts
```

## Architecture

**Router** (`src/webhook-router.ts`) — Central HTTP server. Authenticates incoming webhooks via `X-Gitlab-Token` header, looks up `project_slug` in an in-memory routing table, and forwards the payload to the registered downstream channel. Serves: a session management dashboard at `/`, SSE live updates at `/api/stream`, Prometheus metrics at `/metrics`, and JSON APIs (`/api/health`, `/api/sessions`, `/api/events`, `/api/events/:id`, `/api/stats`, `/api/kill`, `/routes`). Heartbeat re-registrations from channels are handled silently (idempotent).

**Channel** (`src/webhook-channel.ts`) — MCP server over stdio. On startup, binds to port 0 (OS-assigned), self-registers with the router, and maintains a 30s heartbeat for automatic reconnection after router restarts. Forwards raw JSON payloads as `notifications/claude/channel` MCP notifications. Supports remote shutdown via `POST /shutdown`. Unregisters on SIGTERM.

**Observability** (`src/observability.ts`) — Shared library. Structured JSON logger, `EventStore` (ring buffer), `MetricsCollector` (request counts, per-route latency, Prometheus formatting), trace spans with `trace.end(span)` / `trace.elapsed()` API, and payload truncation.

**CLI** (`cmd/hh/main.go`) — Go binary for project setup and session management. Auto-detects project slug from git remote. The project root is embedded at build time via `-ldflags`.

## Data Flow

Webhook POST → Router (auth + route lookup) → Channel HTTP server → MCP channel notification → Claude Code

## Testing

Tests are integration-heavy (77 tests across 4 suites). Router and channel tests spawn actual processes and make real HTTP requests. The router test creates fake downstream servers to verify forwarding. The channel test creates a fake router to capture registration, heartbeat, and shutdown behavior. CLI tests use mock servers for status/kill and temp directories for init. Observability tests are pure unit tests. Tests are isolated and safe to run with a live router on port 9000.

## Environment Variables

- `ROUTER_PORT` — Router listen port (default: 9000)
- `WEBHOOK_SECRET` — Shared secret for webhook auth (default: dev-secret)
- `PROJECT_SLUG` — Channel's project identifier (default: unknown/project)
- `ROUTER_URL` — Channel's router address (default: http://127.0.0.1:9000)
- `LOG_LEVEL` — debug/info/warn/error (default: info)
- `HH_HEARTBEAT_MS` — Channel heartbeat interval in ms (default: 30000)
- `HH_HOME` — Override HookHerald project root for CLI (alternative to build-time embedding)
