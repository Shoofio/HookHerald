# CLI Reference

All `hh` commands, flags, and environment variables.

## Commands

### hh init

Set up HookHerald in the current directory.

```bash
hh init [--slug <slug>] [--router-url <url>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--slug` | auto-detected from git remote | Project identifier (e.g. `mygroup/myapp`) |
| `--router-url` | `http://127.0.0.1:9000` | Router address |

**Creates:**
- `.mcp.json` — MCP server config for Claude Code (merged with existing if present)
- `.hookherald.json` — project config with empty watchers array (won't overwrite if exists)

**Slug auto-detection:**
1. Reads `git remote get-url origin`
2. Parses SSH format: `git@github.com:owner/repo.git` → `owner/repo`
3. Parses HTTPS format: `https://github.com/owner/repo.git` → `owner/repo`
4. Fallback: uses the current directory name

### hh status

Show active sessions registered with the router.

```bash
hh status [--router-url <url>]
```

Displays a table with: slug, port, status, event count, error count, last event time.

### hh kill

Signal a channel to shut down. Claude Code will respawn it automatically.

```bash
hh kill <slug> [--router-url <url>]
```

Useful for bouncing a stuck session. The slug must match a registered session (e.g. `mygroup/myapp`).

### hh router

Start the webhook router.

```bash
hh router [--port <port>] [--secret <secret>] [--bg]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | `9000` | Listen port |
| `--secret` | none | Webhook auth token (opt-in) |
| `--bg` | off | Run in background, write PID to `~/.hookherald/router.pid` |

### hh router stop

Stop a background router.

```bash
hh router stop
```

Reads PID from `~/.hookherald/router.pid` and sends SIGTERM.

## Environment Variables

| Variable | Default | Used by | Description |
|----------|---------|---------|-------------|
| `ROUTER_PORT` | `9000` | Router | Listen port |
| `ROUTER_HOST` | `127.0.0.1` | Router | Bind address (use `0.0.0.0` for Docker) |
| `WEBHOOK_SECRET` | none | Router | Shared secret for webhook auth |
| `PROJECT_SLUG` | `unknown/project` | Channel | Project identifier |
| `ROUTER_URL` | `http://127.0.0.1:9000` | Channel | Router address |
| `HH_CONFIG_PATH` | none | Channel | Path to `.hookherald.json` |
| `HH_HEARTBEAT_MS` | `30000` | Both | Heartbeat interval in ms |
| `LOG_LEVEL` | `info` | Both | `debug`, `info`, `warn`, `error` |

## Router API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/` | Webhook ingestion (auth checked if secret set) |
| `GET` | `/` | Dashboard UI |
| `GET` | `/api/sessions` | List active sessions |
| `GET` | `/api/events` | Query events (`?slug=`, `?limit=`, `?offset=`) |
| `GET` | `/api/events/:id` | Single event by ID |
| `GET` | `/api/stream` | SSE live updates |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/stats` | Aggregated stats |
| `GET` | `/metrics` | Prometheus format metrics |
| `GET` | `/routes` | Active routing table |
| `POST` | `/api/kill` | Gracefully shut down a channel |
