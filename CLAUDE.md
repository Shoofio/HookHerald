# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HookHerald — a webhook relay and watcher system that pushes notifications into running Claude Code sessions via MCP channels.

## Why This Exists

Claude Code has a feature called **message channels** (research preview, shipped March 2025). Channels let external systems push one-way notifications into a running Claude Code session via MCP. A channel server declares the `claude/channel` capability, connects over stdio, and emits `notifications/claude/channel` events — Claude sees these as `<channel source="...">` messages in the conversation.

HookHerald bridges external systems to Claude Code in two ways:

1. **Webhooks** — external systems (GitLab, GitHub, Jenkins, etc.) POST to the router, which forwards to the right channel.
2. **Watchers** — scripts/commands run on an interval, and their stdout is forwarded as notifications. The script decides what to send and when — HookHerald just runs it and delivers the output.

The setup: each Claude Code session spawns a channel as an MCP subprocess (configured in `.mcp.json`). The channel auto-registers with a local router and maintains a 30s heartbeat. Watchers are configured in `.hookherald.json` and spawned by the channel — they share its lifecycle (when Claude Code exits, everything dies cleanly).

## Quick Start

```bash
# 1. Install
npm install -g hookherald

# 2. Start the router
hh router --bg

# 3. In any project directory, set up the channel
cd ~/my-project
hh init

# 4. Start Claude Code with the channel
claude --dangerously-load-development-channels server:webhook-channel

# 5. Send a webhook (no auth by default)
curl -X POST http://127.0.0.1:9000/ \
  -H "Content-Type: application/json" \
  -d '{"project_slug":"my/project","whatever":"you want"}'
```

## Commands

```bash
# CLI
hh init [--slug <s>] [--router-url <u>]   # Set up .mcp.json + .hookherald.json
hh status [--router-url <u>]               # Show active sessions
hh kill <slug> [--router-url <u>]          # Bounce a session (Claude Code respawns it)
hh router [--port <p>] [--secret <s>]      # Start the webhook router
hh router --bg                             # Start router in background
hh router stop                             # Stop background router

# Docker
docker run -d --network host shoofio/hookherald

# Node (development)
npm run router          # Start the webhook router (default port 9000)
npm run channel         # Start an MCP channel server
npm test                # Run all test suites (observability, channel, router, cli)

# Run a single test suite
npx tsx --test-force-exit --test tests/observability.test.ts
npx tsx --test-force-exit --test tests/channel.test.ts
npx tsx --test-force-exit --test tests/router.test.ts
npx tsx --test-force-exit --test tests/cli.test.ts
```

## Architecture

**Router** (`src/webhook-router.ts`) — Central HTTP server. Auth is opt-in: only checks `X-Webhook-Token` / `X-Gitlab-Token` if `WEBHOOK_SECRET` is set. Looks up `project_slug` in an in-memory routing table and forwards to the registered channel. Stores watcher configs per session for dashboard display. Serves: dashboard at `/`, SSE at `/api/stream`, Prometheus at `/metrics`, and JSON APIs (`/api/health`, `/api/sessions`, `/api/events`, `/api/events/:id`, `/api/stats`, `/api/kill`, `/routes`). Heartbeats update watcher lists and broadcast session changes to SSE clients. 10MB request body limit.

**Channel** (`src/webhook-channel.ts`) — MCP server over stdio. Binds to port 0 (OS-assigned), registers with the router (including watcher config), and maintains a 30s heartbeat. Reads `.hookherald.json` via `HH_CONFIG_PATH` env, spawns watchers on startup, and hot-reloads when the config file changes (`fs.watch` with inode-safe re-establishment). Watcher output is POSTed to the router as a webhook with `{ project_slug, source, output }` envelope. Shutdown guard prevents double-cleanup. Unregisters on SIGTERM.

**Observability** (`src/observability.ts`) — Shared library. Structured JSON logger, `EventStore` (ring buffer), `MetricsCollector` (request counts, per-route latency, Prometheus formatting), trace spans with `trace.end(span)` / `trace.elapsed()` API, payload truncation, `WatcherConfig` and `RouteInfo` types.

**CLI** (`src/cli.ts`) — TypeScript CLI installed via npm. Auto-detects project slug from git remote. `hh init` creates both `.mcp.json` and `.hookherald.json`. Resolves channel/router paths relative to the package install location.

**Dashboard** (`src/dashboard.html`) — Live session management UI. Shows sessions with status, events, errors, latency. Watcher tags per session are clickable to filter events by source. SSE-powered updates for sessions, events, and stats.

## Config Files

**`.mcp.json`** — MCP server configuration for Claude Code. Created by `hh init`. Contains the channel command, args, and env (including `HH_CONFIG_PATH`).

**`.hookherald.json`** — HookHerald project config. Created by `hh init`, edited by the user. Contains slug, router URL, and watchers array. The channel hot-reloads this file.

```json
{
  "slug": "mygroup/myapp",
  "router_url": "http://127.0.0.1:9000",
  "watchers": [
    { "command": "./check-pipeline.sh", "interval": 30 },
    { "command": "kubectl get pods -o json", "interval": 60 }
  ]
}
```

## Watchers

Watchers are commands/scripts that run on an interval. The contract:
- **stdout = send**: non-empty stdout gets wrapped in an envelope and POSTed to the router
- **no stdout = skip**: nothing happens
- **exit code is irrelevant**: stdout is extracted even on non-zero exit
- **JSON stdout is parsed**: if stdout is valid JSON, it's nested as an object in the `output` field; otherwise it's a string
- **The script owns dedup and state**: HookHerald doesn't diff or deduplicate — the script decides when to fire

Watcher envelope sent to router:
```json
{
  "project_slug": "<slug from config>",
  "source": "<command string>",
  "output": "<parsed JSON or raw string>"
}
```

## Data Flow

```
Webhooks:  HTTP POST → Router (opt-in auth + route lookup) → Channel → MCP notification → Claude Code
Watchers:  Script stdout → Channel → Router → Channel → MCP notification → Claude Code
```

## Auth

Auth is **opt-in**. By default, no secret is required on any endpoint.

- `hh router` — no auth, all endpoints open (localhost is trusted)
- `hh router --secret <s>` — enables `X-Webhook-Token` check on `POST /` (webhook ingestion only)
- Internal endpoints (`/register`, `/unregister`, `/api/kill`) never require auth

For external webhook sources (GitLab, GitHub), start the router with `--secret` and configure the same secret in the webhook settings.

## Testing

Tests are integration-heavy (89 tests across 4 suites). Router and channel tests spawn actual processes and make real HTTP requests. The router test creates fake downstream servers to verify forwarding. The channel test creates a fake router to capture registration, heartbeat, shutdown, and watcher behavior. CLI tests use mock servers for status/kill and temp directories for init. Observability tests are pure unit tests. Tests are isolated and safe to run with a live router on port 9000.

## Environment Variables

- `ROUTER_PORT` — Router listen port (default: 9000)
- `ROUTER_HOST` — Router bind address (default: 127.0.0.1, use 0.0.0.0 for Docker)
- `WEBHOOK_SECRET` — Shared secret for webhook auth (default: none, auth disabled)
- `PROJECT_SLUG` — Channel's project identifier (default: unknown/project)
- `ROUTER_URL` — Channel's router address (default: http://127.0.0.1:9000)
- `LOG_LEVEL` — debug/info/warn/error (default: info)
- `HH_HEARTBEAT_MS` — Channel heartbeat interval in ms (default: 30000)
- `HH_CONFIG_PATH` — Path to `.hookherald.json` (set automatically by `hh init`)
