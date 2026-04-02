# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

HookHerald — a webhook relay that receives GitLab CI pipeline events, routes them by project slug to downstream channel servers, and surfaces them as MCP channel notifications for Claude Code.

## Why This Exists

Claude Code has a feature called **message channels** (research preview, shipped March 2025). Channels let external systems push one-way notifications into a running Claude Code session via MCP. A channel server declares the `claude/channel` capability, connects over stdio, and emits `notifications/claude/channel` events — Claude sees these as `<channel source="...">` messages in the conversation.

HookHerald is a general-purpose webhook-to-channel bridge. Any system that can fire an HTTP POST — CI pipelines, monitoring alerts, deployment hooks, chat bots, cron jobs — can push notifications into a running Claude Code session. The primary use case is GitLab CI (pipeline pass/fail results), but the router and channel are payload-agnostic.

The setup: each Claude Code session spawns a webhook channel server as an MCP subprocess (configured in `.mcp.json`). The channel auto-registers with a central router. External systems post webhook events to the router, which forwards them to the right channel based on project slug. Multiple sessions can run in parallel (e.g., in tmux), each handling different projects.

## Commands

```bash
npm run router          # Start the webhook router (default port 9000)
npm run channel         # Start an MCP channel server (auto-assigns port, registers with router)
npm test                # Run all test suites (observability, channel, router)

# Run a single test suite
npx tsx --test-force-exit --test tests/observability.test.ts
npx tsx --test-force-exit --test tests/channel.test.ts
npx tsx --test-force-exit --test tests/router.test.ts
```

## Architecture

Three components, all in `src/`:

**Router** (`webhook-router.ts`) — Central HTTP server. Authenticates incoming webhooks via `X-Gitlab-Token` header against a shared secret, looks up the project slug in an in-memory routing table, and forwards the payload to the registered downstream channel's port. Also serves: an SSE-powered live dashboard (`dashboard.html`), a Prometheus `/metrics` endpoint, and JSON APIs (`/api/events`, `/api/stats`, `/routes`). Channels self-register/unregister via `POST /register` and `POST /unregister`.

**Channel** (`webhook-channel.ts`) — MCP server over stdio. On startup, binds to port 0 (OS-assigned), self-registers with the router, and listens for forwarded webhooks. Converts payloads into `notifications/claude/channel` MCP notifications. Unregisters on SIGTERM.

**Observability** (`observability.ts`) — Shared library used by both router and channel. Provides: structured JSON logger, `EventStore` (ring buffer), `MetricsCollector` (request counts, per-route latency, Prometheus formatting), trace spans, and payload truncation.

## Data Flow

GitLab webhook → Router (auth + route lookup) → Channel HTTP server → MCP channel notification → Claude

## Testing

Tests are integration-heavy. Router and channel tests spawn the actual processes and make real HTTP requests. The router test creates fake downstream servers to verify forwarding. The channel test creates a fake router to capture registration. Observability tests are pure unit tests.

## Environment Variables

- `ROUTER_PORT` — Router listen port (default: 9000)
- `WEBHOOK_SECRET` — Shared secret for webhook auth (default: dev-secret)
- `PROJECT_SLUG` — Channel's project identifier (default: unknown/project)
- `ROUTER_URL` — Channel's router address (default: http://127.0.0.1:9000)
- `LOG_LEVEL` — debug/info/warn/error (default: info)
