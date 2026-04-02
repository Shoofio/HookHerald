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

Requires Node.js >= 18.

## Quick Start

```bash
# 1. Start the router
hh router --bg

# 2. Set up a project
cd ~/my-project
hh init

# 3. Start Claude Code
claude --dangerously-load-development-channels server:webhook-channel

# 4. Send a webhook
curl -X POST http://127.0.0.1:9000/ \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Token: dev-secret" \
  -d '{"project_slug":"my-group/my-project","status":"deployed","version":"1.2.3"}'
```

## CLI

```
hh init   [--slug <slug>] [--router-url <url>]   Set up .mcp.json in current directory
hh status [--router-url <url>]                    Show active sessions
hh kill   <slug> [--router-url <url>]             Bounce a session
hh router [--port <port>] [--secret <secret>]     Start the webhook router
          [--bg]                                  Run in background
hh router stop                                    Stop background router
```

`hh init` auto-detects the project slug from `git remote origin`. Merges with existing `.mcp.json` if present.

`hh kill` signals the channel to shut down. Claude Code will respawn it — use this to bounce a session, not permanently remove it.

## Docker

The router can also run via Docker (requires `--network host` on Linux):

```bash
docker run -d --network host -e WEBHOOK_SECRET=my-secret shoofio/hookherald
```

> For rootless Docker or Docker Desktop (Mac/Windows), use `hh router` instead.

## Router API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Receive webhook (requires `X-Webhook-Token` or `X-Gitlab-Token`) |
| `POST` | `/api/kill` | Remove a session (signals channel to shut down) |
| `GET` | `/` | Session management dashboard |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/sessions` | Active sessions with metrics |
| `GET` | `/api/events` | Query events (`?slug=`, `?limit=`, `?offset=`) |
| `GET` | `/api/events/:id` | Single event by ID |
| `GET` | `/api/stream` | SSE live updates |
| `GET` | `/metrics` | Prometheus format |

## Dashboard

Live session management UI at `http://127.0.0.1:9000/`:

- **Sessions** — status, events, errors, latency, kill button
- **Events** — click sessions to filter, ctrl/shift for multi-select
- **Detail** — trace waterfall, raw payload
- **Live** — SSE-powered, no refresh

## GitLab CI

Add a webhook in project settings, or use a CI step:

```yaml
notify:
  stage: .post
  script:
    - |
      curl -s -X POST http://$ROUTER_HOST:9000/ \
        -H "Content-Type: application/json" \
        -H "X-Webhook-Token: $WEBHOOK_SECRET" \
        -d "{\"project_slug\":\"$CI_PROJECT_PATH\",\"status\":\"$CI_PIPELINE_STATUS\",\"branch\":\"$CI_COMMIT_BRANCH\",\"sha\":\"$CI_COMMIT_SHA\"}"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_PORT` | `9000` | Router listen port |
| `ROUTER_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for Docker) |
| `WEBHOOK_SECRET` | `dev-secret` | Auth secret |
| `PROJECT_SLUG` | `unknown/project` | Channel's project ID |
| `ROUTER_URL` | `http://127.0.0.1:9000` | Router address |
| `LOG_LEVEL` | `info` | debug/info/warn/error |
| `HH_HEARTBEAT_MS` | `30000` | Channel heartbeat interval |

## License

MIT
