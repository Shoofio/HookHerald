# HookHerald

A webhook relay that pushes notifications into running [Claude Code](https://claude.ai/code) sessions. Any system that can fire an HTTP POST — CI pipelines, monitoring alerts, deployment hooks, chat bots, cron jobs — can send messages directly into your Claude conversation.

## How It Works

```
Webhook POST ──> Router (auth + route) ──> Channel ──> Claude Code session
                   :9000                   (MCP)       <channel> notification
```

The **router** is a central HTTP server that receives webhooks and forwards them by `project_slug` to the right session. Each Claude Code session runs a **channel** (MCP server) that auto-registers with the router. The **CLI** (`hh`) sets everything up.

Payloads are forwarded as raw JSON — send whatever you want, the agent figures it out.

## Install

```bash
npm install -g hookherald
```

That's it. Requires Node.js >= 18.

## Usage

### 1. Start the router

```bash
hh router             # foreground (see logs, ctrl+c to stop)
hh router --bg        # background (detach, write PID file)
hh router stop        # stop background router
```

Dashboard at `http://127.0.0.1:9000/`.

### 2. Set up a project

```bash
cd ~/my-project
hh init
```

Auto-detects the project slug from `git remote origin` and writes `.mcp.json`. Merges with existing config if present.

### 3. Start Claude Code

```bash
claude --dangerously-load-development-channels server:webhook-channel
```

The channel starts, registers with the router, and maintains a heartbeat. If the router restarts, the channel reconnects automatically. When the session ends, the channel cleans up after itself.

### 4. Send webhooks

```bash
curl -X POST http://127.0.0.1:9000/ \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: dev-secret" \
  -d '{"project_slug":"my-group/my-project","status":"deployed","version":"1.2.3"}'
```

The only required field is `project_slug` for routing — everything else passes through as raw JSON.

The `X-Webhook-Token` header authenticates the request against `WEBHOOK_SECRET`. GitLab sends this natively as `X-Gitlab-Token` when you configure a webhook secret — the router accepts both headers.

## CLI Reference

```
hh init   [--slug <slug>] [--router-url <url>]   Set up .mcp.json in current directory
hh status [--router-url <url>]                    Show active sessions
hh kill   <slug> [--router-url <url>]             Bounce a session (Claude Code respawns it)
hh router [--port <port>] [--secret <secret>]     Start the webhook router
          [--bg]                                  Run in background
hh router stop                                    Stop background router
```

## Docker

The router can also run via Docker. Requires `--network host` to reach channel processes on localhost:

```bash
docker run -d --network host -e WEBHOOK_SECRET=my-secret shoofio/hookherald
```

> **Note:** `--network host` requires Linux with standard Docker. For rootless Docker or Docker Desktop (Mac/Windows), use `hh router` instead.

## Router API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Receive webhook (requires `X-Webhook-Token` or `X-Gitlab-Token` header) |
| `POST` | `/register` | Channel self-registration |
| `POST` | `/unregister` | Channel self-unregistration |
| `POST` | `/api/kill` | Remove a session (signals channel to shut down) |
| `GET` | `/` | Session management dashboard |
| `GET` | `/api/health` | Router health check |
| `GET` | `/api/sessions` | List active sessions with metrics |
| `GET` | `/api/events` | Query events (`?slug=`, `?limit=`, `?offset=`) |
| `GET` | `/api/events/:id` | Single event by ID |
| `GET` | `/api/stats` | Aggregated statistics |
| `GET` | `/api/stream` | SSE live updates |
| `GET` | `/routes` | Raw routing table |
| `GET` | `/metrics` | Prometheus format metrics |

## Dashboard

The router serves a live session management UI at `http://127.0.0.1:9000/`:

- **Sessions table** — status, port, event count, errors, latency, kill button
- **Event feed** — click sessions to filter, ctrl/shift+click for multi-select
- **Event detail** — expand inline for summary, trace waterfall, raw payload
- **Live updates** — SSE-powered, no refresh needed

## GitLab CI Integration

Add a webhook in your GitLab project/group settings:
- **URL**: `http://<your-machine>:9000/`
- **Secret token**: your `WEBHOOK_SECRET`
- **Trigger**: Pipeline events (or any events you want)

Or add a `curl` step in `.gitlab-ci.yml` for custom payloads:

```yaml
notify:
  stage: .post
  script:
    - |
      curl -s -X POST http://$ROUTER_HOST:9000/ \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Token: $WEBHOOK_SECRET" \
        -d "{\"project_slug\":\"$CI_PROJECT_PATH\",\"status\":\"$CI_PIPELINE_STATUS\",\"branch\":\"$CI_COMMIT_BRANCH\",\"sha\":\"$CI_COMMIT_SHA\",\"pipeline\":\"$CI_PIPELINE_URL\"}"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_PORT` | `9000` | Router listen port |
| `ROUTER_HOST` | `127.0.0.1` | Router bind address (`0.0.0.0` for Docker) |
| `WEBHOOK_SECRET` | `dev-secret` | Shared secret for webhook auth |
| `PROJECT_SLUG` | `unknown/project` | Channel's project identifier |
| `ROUTER_URL` | `http://127.0.0.1:9000` | Channel's router address |
| `LOG_LEVEL` | `info` | Log level (debug/info/warn/error) |
| `HH_HEARTBEAT_MS` | `30000` | Channel heartbeat interval |

## Alternative: Go CLI

A compiled Go binary is also available for faster startup (~5ms vs ~700ms). See `cmd/hh/` and [releases](https://github.com/Shoofio/HookHerald/releases).

## Testing

```bash
npm test    # 79 tests across 4 suites
```

Tests are integration-heavy — they spawn real processes and make real HTTP requests. Safe to run with a live router.
