# Troubleshooting

Common issues and how to fix them.

## Router not running

**Symptom:** `hh status` fails with connection refused.

**Fix:**
```bash
hh router --bg
```

Check if it's already running: `cat ~/.hookherald/router.pid` and `ps -p $(cat ~/.hookherald/router.pid)`.

If the PID file exists but the process is dead, delete it and restart:
```bash
rm ~/.hookherald/router.pid
hh router --bg
```

## Channel not registering

**Symptom:** Router is running but `hh status` shows no sessions.

**Diagnosis:**
1. Check `.mcp.json` exists in the project directory
2. Verify Claude Code was started from the directory containing `.mcp.json`
3. Check Claude Code's stderr for channel startup errors

**Fix:** Re-run `hh init` and restart Claude Code. The channel registers on startup — if it failed to start, no session will appear.

## Watcher not firing

**Symptom:** Watcher is in `.hookherald.json` but nothing happens.

**Diagnosis:**
1. Run the script manually: `./my-watcher.sh` — does it produce output?
2. If no output: the script's own logic decided nothing changed. Check state files in `/tmp/`.
3. If yes output: check `.hookherald.json` is valid JSON (a syntax error prevents hot reload)
4. Check the interval — it's in seconds, not milliseconds

**Fix:**
- Delete the state file to force a re-report: `rm /tmp/hh-my-watcher-state`
- Validate JSON: `cat .hookherald.json | jq .`
- Check the dashboard at `http://127.0.0.1:9000` — is the watcher listed under the session?

## Watcher fires once then stops

**Symptom:** First notification works, then silence.

This is almost always the script's dedup logic working correctly — nothing actually changed, so the script produces no output.

**Diagnosis:**
1. Delete the state file and run manually — does it output again?
2. Check if the underlying data actually changed between runs

**Fix:** If you want the watcher to report even when unchanged, remove the state comparison from the script. But usually, the dedup is doing its job.

## Script works manually but not as a watcher

**Symptom:** `./my-script.sh` works in the terminal but produces nothing when run by HookHerald.

**Causes:**
- **PATH issues**: Watchers run via `sh -c`, which may have a different PATH. Use full paths to binaries: `/usr/local/bin/kubectl` instead of `kubectl`.
- **Environment variables**: The watcher inherits the channel's environment, not your shell's. Variables like `KUBECONFIG`, `GITLAB_TOKEN`, etc. must be exported before starting Claude Code, or set in `.hookherald.json` env.
- **Working directory**: Watchers run from the project root (where `.hookherald.json` lives). Use absolute paths or `cd` in the script.
- **Permissions**: Ensure the script is executable: `chmod +x my-script.sh`

## No notifications appearing in Claude Code

**Symptom:** Dashboard shows events, watcher is listed, but Claude doesn't mention anything.

**Diagnosis:**
1. Check the dashboard — are events being recorded? If yes, the router is receiving them.
2. Check if the channel is registered (session appears in `hh status`).
3. Check if the event's `project_slug` matches the channel's slug.

**Fix:**
- If events show but Claude ignores them: the notification was delivered but may not be actionable enough. Make your script output structured JSON that clearly describes what happened and what needs attention.
- If no events show: the watcher isn't POSTing to the router. Check the channel's stderr logs for errors.

## Hot reload not working

**Symptom:** Edited `.hookherald.json` but watchers didn't change.

**Diagnosis:**
1. Validate JSON syntax: `cat .hookherald.json | jq .`
2. Check that you're editing the right file (the one pointed to by `HH_CONFIG_PATH` in `.mcp.json`)

**Fix:** Invalid JSON silently prevents reload. Fix the syntax error and save again. If still stuck, restart Claude Code — the channel reloads config on startup.

## Webhook not forwarding

**Symptom:** `curl -X POST http://127.0.0.1:9000/ ...` returns 404 or 401.

**Diagnosis:**
- **404 (no route)**: The `project_slug` in the POST body doesn't match any registered session. Check `hh status` for the exact slug.
- **401 (unauthorized)**: The router was started with `--secret` but the request is missing the `X-Webhook-Token` header.
- **400 (bad request)**: The POST body isn't valid JSON, or `project_slug` is missing.

**Fix:** Ensure the `project_slug` in the webhook payload exactly matches the slug in `.hookherald.json`.

## Dashboard not showing watchers

**Symptom:** Session appears but no watcher tags.

The watcher list syncs via heartbeat (every 30 seconds by default). Wait for the next heartbeat cycle. If still missing after 60 seconds, the watchers may not be in `.hookherald.json` or the config failed to load.
