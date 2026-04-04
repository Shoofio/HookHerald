# HookHerald

A watcher and webhook relay that pushes notifications into running [Claude Code](https://claude.ai/code) sessions. Any script that can print to stdout — or any system that can fire an HTTP POST — can send messages directly into your Claude conversation.

## How It Works

```
Watchers:  Script stdout ──> Channel ──> Router ──> Channel ──> Claude Code
Webhooks:  HTTP POST ──> Router ──> Channel ──> Claude Code
```

The **CLI** (`hh`) sets everything up. Each Claude Code session runs a **channel** (MCP server) that auto-registers with a local **router**. **Watchers** are scripts that run on an interval — their stdout becomes notifications. The router also accepts **webhooks** from external systems and forwards them by `project_slug`.

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

# 3. Start Claude Code (from the same directory — it needs .mcp.json and .hookherald.json)
claude --dangerously-load-development-channels server:webhook-channel
```

`hh init` creates `.hookherald.json` with an empty watchers array and `.mcp.json` for the channel. Edit `.hookherald.json` to add watchers:

```json
{
  "slug": "mygroup/myapp",
  "router_url": "http://127.0.0.1:9000",
  "watchers": [
    { "command": "./check-pipeline.sh", "interval": 30 },
    { "command": "kubectl get pods -n default -o json", "interval": 60 }
  ]
}
```

## Watchers

Watchers poll external systems and push notifications into Claude Code. The contract is simple — HookHerald runs your command and forwards whatever it prints:

- **stdout = send** — any non-empty stdout gets forwarded to Claude Code as a notification
- **no stdout = skip** — nothing happens, no notification
- **exit code doesn't matter** — only stdout counts, output is captured even on non-zero exit
- **JSON stdout is parsed** — valid JSON stays structured, plain text stays as a string
- **No diffing** — HookHerald doesn't compare outputs between runs. If your script prints something, it gets sent. The script decides when to fire and handles its own state/dedup.

### Example: Watch CI Pipeline

```bash
#!/bin/bash
# check-ci.sh — notify on GitHub Actions status changes
STATE_FILE="/tmp/hh-ci-state"
REPO="myorg/myrepo"

RUN=$(gh run list --repo "$REPO" --limit 1 --json databaseId,status,conclusion,headBranch,event,createdAt,url 2>/dev/null | jq '.[0]')
[ -z "$RUN" ] || [ "$RUN" = "null" ] && exit 0

KEY=$(echo "$RUN" | jq -r '[.databaseId, .status, .conclusion] | join(":")')
LAST=$(cat "$STATE_FILE" 2>/dev/null)
[ "$KEY" = "$LAST" ] && exit 0

echo "$KEY" > "$STATE_FILE"
echo "$RUN"
```

### Example: Watch Kubernetes Pods

```bash
#!/bin/bash
# watch-pods.sh — notify when pod states change
STATE_FILE="/tmp/hh-pods-state"

CURRENT=$(kubectl get pods -n default -o json 2>/dev/null | jq -c \
  '[.items[] | {name: .metadata.name, phase: .status.phase, ready: (.status.containerStatuses // [] | map(.ready) | all), restarts: (.status.containerStatuses // [] | map(.restartCount) | add // 0)}] | sort_by(.name)')

if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then exit 0; fi

LAST=$(cat "$STATE_FILE" 2>/dev/null)
if [ "$CURRENT" = "$LAST" ]; then exit 0; fi

echo "$CURRENT" > "$STATE_FILE"
echo "$CURRENT" | jq '{
  pods: .,
  summary: {
    total: (. | length),
    running: ([.[] | select(.phase == "Running")] | length),
    not_ready: ([.[] | select(.ready == false)] | length),
    crashing: ([.[] | select(.restarts > 3)] | length)
  }
}'
```

### Example: Watch GitLab Pipeline

```bash
#!/bin/bash
# check-pipeline.sh — notify on pipeline completion
STATE_FILE="/tmp/hh-pipeline-last"

PIPELINE=$(curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.com/api/v4/projects/mygroup%2Fmyapp/pipelines/latest")

ID=$(echo "$PIPELINE" | jq -r '.id')
STATUS=$(echo "$PIPELINE" | jq -r '.status')
LAST=$(cat "$STATE_FILE" 2>/dev/null)

case "$STATUS" in
  failed|success|canceled)
    [ "$ID" = "$LAST" ] && exit 0
    echo "$ID" > "$STATE_FILE"
    echo "$PIPELINE" | jq '{
      pipeline_id: .id,
      status: .status,
      ref: .ref,
      url: .web_url
    }'
    ;;
esac
```

### Hot Reload

Edit `.hookherald.json` while Claude Code is running — watchers are added/removed automatically. No restart needed. The dashboard updates within 30 seconds.

See [examples/README.md](examples/README.md) for detailed walkthroughs, more scripts, writing your own watchers, and troubleshooting.

## Webhooks

The router also accepts webhooks from external systems. Any HTTP POST with a `project_slug` field gets forwarded to the matching channel:

```bash
curl -X POST http://127.0.0.1:9000/ \
  -H "Content-Type: application/json" \
  -d '{"project_slug":"my-group/my-project","status":"deployed","version":"1.2.3"}'
```

No auth by default — localhost is trusted. See [Auth](#auth) to enable it.

## CLI

```
hh init   [--slug <slug>] [--router-url <url>]   Set up .mcp.json + .hookherald.json
hh status [--router-url <url>]                    Show active sessions
hh kill   <slug> [--router-url <url>]             Bounce a session
hh router [--port <port>] [--secret <secret>]     Start the webhook router
          [--bg]                                  Run in background
hh router stop                                    Stop background router
```

`hh init` auto-detects the project slug from `git remote origin`. Creates `.hookherald.json` with an empty watchers array. Merges with existing `.mcp.json` if present. Won't overwrite an existing `.hookherald.json`.

`hh kill` signals the channel to shut down. Claude Code will respawn it.

## Auth

Auth is opt-in. By default, no secret is needed — everything runs on localhost.

```bash
# No auth (default)
hh router

# Enable auth on webhook ingestion
hh router --secret my-secret
```

When a secret is set, `POST /` requires `X-Webhook-Token` (or `X-Gitlab-Token`). Internal endpoints (`/register`, `/unregister`, `/api/kill`) never require auth.

For external sources (GitLab CI, GitHub Actions), start the router with `--secret` and configure the same secret in the webhook settings.

## Docker

The router can also run via Docker (requires `--network host` on Linux):

```bash
docker run -d --network host shoofio/hookherald

# With auth
docker run -d --network host -e WEBHOOK_SECRET=my-secret shoofio/hookherald
```

> For rootless Docker or Docker Desktop (Mac/Windows), use `hh router` instead.

## Dashboard

Live session management UI at `http://127.0.0.1:9000/`:

- **Sessions** — status, events, errors, latency, kill button
- **Watchers** — shown per session with command and interval, click to filter events by source
- **Events** — click sessions to filter, ctrl/shift for multi-select, expand for trace waterfall and payload
- **Live** — SSE-powered, no refresh needed

## Router API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Receive webhook (auth required only if `WEBHOOK_SECRET` is set) |
| `POST` | `/api/kill` | Remove a session (signals channel to shut down) |
| `GET` | `/` | Dashboard |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/sessions` | Active sessions with metrics and watchers |
| `GET` | `/api/events` | Query events (`?slug=`, `?limit=`, `?offset=`) |
| `GET` | `/api/events/:id` | Single event by ID |
| `GET` | `/api/stream` | SSE live updates |
| `GET` | `/metrics` | Prometheus format |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUTER_PORT` | `9000` | Router listen port |
| `ROUTER_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for Docker) |
| `WEBHOOK_SECRET` | *(none)* | Auth secret (opt-in) |
| `PROJECT_SLUG` | `unknown/project` | Channel's project ID |
| `ROUTER_URL` | `http://127.0.0.1:9000` | Router address |
| `LOG_LEVEL` | `info` | debug/info/warn/error |
| `HH_HEARTBEAT_MS` | `30000` | Channel heartbeat interval |
| `HH_CONFIG_PATH` | *(none)* | Path to `.hookherald.json` (set by `hh init`) |

## License

MIT
