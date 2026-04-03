# HookHerald Examples

Real-world examples of using HookHerald to push notifications into Claude Code sessions.

## When to Use What

| I want to... | Use | Why |
|---|---|---|
| Know when my CI pipeline fails | **Watcher** (polling) | Script checks pipeline status every 30s. No need to configure webhooks in GitLab/GitHub. |
| Get instant CI notifications | **Webhook** (push) | GitLab/GitHub POSTs to the router on pipeline events. Faster, but needs network access to the router. |
| Monitor Kubernetes pods | **Watcher** (polling) | Script checks pod states on an interval. Reports changes, stays silent when stable. |
| React to deployment rollouts | **Watcher** (polling) | Script watches rollout status. Notifies Claude when something gets stuck. |
| Forward Slack/Discord messages | **Webhook** (push) | Bot POSTs to the router when a message matches a pattern. |
| Watch a log file for errors | **Watcher** (polling) | Script tails the log, outputs new errors since last check. |
| Run arbitrary health checks | **Watcher** (polling) | Script curls an endpoint, outputs the response if something's wrong. |

**Rule of thumb:** If the source system can POST to you, use a webhook. If you need to go check something, use a watcher.

## Setup Walkthrough

### 1. Install and Initialize

```bash
npm install -g hookherald

# Start the router (runs in background)
hh router --bg

# In your project directory
cd ~/my-project
hh init
```

This creates two files:

- **`.mcp.json`** — tells Claude Code how to spawn the channel (MCP server)
- **`.hookherald.json`** — your project config with an empty watchers array

```json
{
  "slug": "mygroup/myapp",
  "router_url": "http://127.0.0.1:9000",
  "watchers": []
}
```

### 2. Start Claude Code

Launch Claude Code **from the same directory** where `.mcp.json` and `.hookherald.json` live:

```bash
cd ~/my-project
claude --dangerously-load-development-channels server:webhook-channel
```

The channel starts, registers with the router, and you'll see the session appear on the dashboard at `http://127.0.0.1:9000`.

### 3. Add a Watcher

Edit `.hookherald.json` directly — no restart needed, the channel hot-reloads:

```json
{
  "slug": "mygroup/myapp",
  "router_url": "http://127.0.0.1:9000",
  "watchers": [
    { "command": "./watch-pods.sh", "interval": 10 }
  ]
}
```

The watcher runs immediately, then every 10 seconds. The dashboard shows it within 30 seconds.

### 4. Remove a Watcher

Delete the entry from the watchers array. The channel stops it automatically.

---

## Example: Kubernetes Pod Monitor

**File:** `watch-pods.sh`

### What it does

Checks pods in the default namespace every N seconds. Reports when pod states change (new pod, pod crashed, pod recovered). Stays silent when everything is stable.

### Why you'd want it

You're working with Claude on a deployment. Claude makes changes, applies manifests, and needs to know if pods come up healthy or crash. Instead of manually running `kubectl get pods`, the watcher tells Claude automatically.

### How it works

1. Runs `kubectl get pods -n default -o json`
2. Extracts per-pod state: name, phase, readiness, restart count
3. Compares against the last known state (stored in a temp file)
4. If nothing changed: no output, no notification
5. If something changed: outputs a JSON summary

### State management

The script stores the last known pod state in `/tmp/hh-pods-state`. On each run:
- First run: no state file exists, so any pods found are reported
- Subsequent runs: output is compared to the file; only changes trigger output
- The state file survives across watcher restarts but is cleared on reboot

To force a re-report, delete the state file: `rm /tmp/hh-pods-state`

### What Claude sees

When a pod changes state, Claude receives a channel notification like:

```
<channel source="webhook-channel">
{
  "project_slug": "mygroup/myapp",
  "source": "./watch-pods.sh",
  "output": {
    "pods": [
      { "name": "nginx-abc123", "phase": "Running", "ready": true, "restarts": 0 },
      { "name": "api-def456", "phase": "CrashLoopBackOff", "ready": false, "restarts": 7 }
    ],
    "summary": {
      "total": 2,
      "running": 1,
      "not_ready": 1,
      "crashing": 1
    }
  }
}
</channel>
```

Claude can then investigate — check logs, look at the manifest, suggest fixes.

### The script

```bash
#!/bin/bash
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

### Config

```json
{ "command": "./watch-pods.sh", "interval": 10 }
```

---

## Example: GitLab Pipeline Monitor

**File:** `check-pipeline.sh`

### What it does

Polls the GitLab API for the latest pipeline status. Notifies when a pipeline finishes (success, failed, or canceled). Ignores pipelines that are still running.

### Why you'd want it

You push code, a pipeline starts, and you keep working with Claude. When the pipeline finishes, Claude gets notified and can react — look at the failure, check logs, make a fix, push again. The loop runs without you checking GitLab.

### How it works

1. Calls GitLab's REST API for the latest pipeline
2. Checks if the status is terminal (success/failed/canceled)
3. Compares the pipeline ID against the last reported one
4. If it's a new completed pipeline: outputs a JSON summary
5. If it's still running or already reported: no output

### State management

Stores the last reported pipeline ID in `/tmp/hh-pipeline-last`. This prevents re-reporting the same pipeline on every interval. When a new pipeline runs and finishes, it has a different ID, so it gets reported.

### What Claude sees

```
<channel source="webhook-channel">
{
  "project_slug": "mygroup/myapp",
  "source": "./check-pipeline.sh",
  "output": {
    "pipeline_id": 4821,
    "status": "failed",
    "ref": "main",
    "url": "https://gitlab.com/mygroup/myapp/-/pipelines/4821"
  }
}
</channel>
```

### The script

```bash
#!/bin/bash
STATE_FILE="/tmp/hh-pipeline-last"

PIPELINE=$(curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "https://gitlab.com/api/v4/projects/${GITLAB_PROJECT_ID}/pipelines/latest")

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

### Prerequisites

```bash
export GITLAB_TOKEN="glpat-xxxxxxxxxxxx"
export GITLAB_PROJECT_ID="12345"  # or URL-encoded path like "mygroup%2Fmyapp"
```

### Config

```json
{ "command": "./check-pipeline.sh", "interval": 30 }
```

---

## Example: Deployment Rollout Monitor

**File:** `watch-deployment.sh`

### What it does

Watches a Kubernetes deployment rollout. Reports when the rollout is progressing, stuck, or complete. Goes silent once the rollout is stable.

### Why you'd want it

Claude applies a deployment change. The rollout takes time — new pods spin up, old pods terminate. This watcher tells Claude if the rollout is stuck (image pull errors, crash loops) so it can investigate immediately.

### The script

```bash
#!/bin/bash
DEPLOYMENT="${1:-myapp}"
NAMESPACE="${2:-default}"
STATE_FILE="/tmp/hh-rollout-${DEPLOYMENT}"

STATUS=$(kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=1s 2>&1)
EXIT_CODE=$?

# Build a state snapshot
CURRENT=$(kubectl get deployment $DEPLOYMENT -n $NAMESPACE -o json 2>/dev/null | jq -c '{
  replicas: .status.replicas,
  ready: .status.readyReplicas,
  updated: .status.updatedReplicas,
  available: .status.availableReplicas,
  conditions: [.status.conditions[] | {type: .type, status: .status, reason: .reason}]
}')

if [ -z "$CURRENT" ]; then exit 0; fi

LAST=$(cat "$STATE_FILE" 2>/dev/null)
if [ "$CURRENT" = "$LAST" ]; then exit 0; fi

echo "$CURRENT" > "$STATE_FILE"

# Determine overall state
if [ $EXIT_CODE -eq 0 ]; then
  ROLLOUT_STATE="complete"
else
  ROLLOUT_STATE="in_progress"
  echo "$STATUS" | grep -q "timed out" && ROLLOUT_STATE="stuck"
fi

echo "$CURRENT" | jq --arg state "$ROLLOUT_STATE" --arg deploy "$DEPLOYMENT" '{
  deployment: $deploy,
  rollout_state: $state,
  status: .
}'
```

### Config

```json
{ "command": "./watch-deployment.sh myapp default", "interval": 10 }
```

---

## Writing Your Own Watcher

### The minimal template

```bash
#!/bin/bash
# 1. Check something
# 2. Decide if it's worth reporting
# 3. Print to stdout if yes, print nothing if no

RESULT=$(your-command-here)

if [ -z "$RESULT" ]; then
  exit 0
fi

echo "$RESULT"
```

That's it. HookHerald handles the rest.

### Adding state (dedup)

If your source fires the same event repeatedly, add a state file:

```bash
#!/bin/bash
STATE_FILE="/tmp/hh-my-watcher-state"

CURRENT=$(your-command-here)
LAST=$(cat "$STATE_FILE" 2>/dev/null)

if [ "$CURRENT" = "$LAST" ]; then exit 0; fi

echo "$CURRENT" > "$STATE_FILE"
echo "$CURRENT"
```

### Testing standalone

Run your script by hand first:

```bash
# Should produce output (something to report)
./my-watcher.sh

# Run again immediately — should produce nothing (state unchanged)
./my-watcher.sh

# Clear state and run again — should produce output
rm /tmp/hh-my-watcher-state
./my-watcher.sh
```

If the standalone output looks right, plug it into `.hookherald.json`.

### Tips

- **Output JSON when you can.** Claude works better with structured data than plain text.
- **Keep scripts fast.** They block the interval — if your script takes 20s and the interval is 10s, you'll miss ticks.
- **Use jq for JSON manipulation.** It's the standard tool and handles edge cases well.
- **State files go in `/tmp/`.** They survive reboots if needed, but you can always clear them to force a re-check.
- **Test the script, not HookHerald.** If the script produces the right output standalone, it'll work as a watcher.

---

## Troubleshooting

### Watcher isn't firing

1. Run the script manually: `./my-watcher.sh` — does it produce output?
2. Check the state file — it may think nothing changed. Delete it and try again.
3. Check the interval — is it set in seconds (not milliseconds)?
4. Check the dashboard — is the watcher listed under the session?

### Watcher fires once but never again

HookHerald sends whatever the script prints to stdout — it doesn't do any diffing itself. If your script stopped producing output, it's because the script's own state logic decided nothing new happened. Check the state file your script uses and delete it to force a re-report.

### Dashboard not showing watchers

The watcher list syncs via heartbeat (every 30s). Wait for the next heartbeat, or restart Claude Code.

### Script works manually but not as a watcher

- Check the working directory — watchers run from the project root (where `.hookherald.json` is)
- Check that required tools (`jq`, `kubectl`, `curl`) are in the PATH
- Check environment variables — the watcher inherits the channel's env, not your shell's. Set variables in `.hookherald.json` env or export them before starting Claude Code.

### Events show up but Claude doesn't react

The notification was delivered — check the channel logs (stderr). If Claude ignores it, it's likely not actionable enough. Make your script output clear, structured JSON that describes what happened and what needs attention.
