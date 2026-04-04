# Watcher Examples

Real-world watcher scripts. Each follows the watcher contract: stdout = send, empty = skip, script owns state.

## Table of Contents

- [GitHub Actions CI](#github-actions-ci)
- [Kubernetes Pod Monitor](#kubernetes-pod-monitor)
- [GitLab Pipeline Monitor](#gitlab-pipeline-monitor)
- [Kubernetes Deployment Rollout](#kubernetes-deployment-rollout)
- [HTTP Health Check](#http-health-check)

---

## GitHub Actions CI

Polls `gh run list` for the latest workflow run. Reports when status or conclusion changes.

**Requires:** `gh` CLI installed and authenticated, `jq`

```bash
#!/usr/bin/env bash
set -uo pipefail

STATE_FILE="${HH_STATE_DIR:-/tmp}/.hh-ci-last"
REPO="owner/repo"  # Change this

RUN=$(gh run list --repo "$REPO" --limit 1 --json databaseId,status,conclusion,headBranch,event,name,createdAt,url 2>/dev/null)

if [ -z "$RUN" ] || [ "$RUN" = "[]" ]; then
  exit 0
fi

RUN_ID=$(echo "$RUN" | jq -r '.[0].databaseId')
STATUS=$(echo "$RUN" | jq -r '.[0].status')
CONCLUSION=$(echo "$RUN" | jq -r '.[0].conclusion // "pending"')
KEY="${RUN_ID}:${STATUS}:${CONCLUSION}"

LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "")
if [ "$KEY" = "$LAST" ]; then
  exit 0
fi
echo "$KEY" > "$STATE_FILE"

echo "$RUN" | jq '.[0] | {
  run_id: .databaseId,
  workflow: .name,
  status: .status,
  conclusion: (.conclusion // "pending"),
  branch: .headBranch,
  event: .event,
  created: .createdAt,
  url: .url
}'
```

**Config:**
```json
{ "command": "./check-ci.sh", "interval": 15 }
```

**State:** Stores `runId:status:conclusion` in state file. Reports on any change — not just completion, but also transitions like queued → in_progress.

---

## Kubernetes Pod Monitor

Checks pods in a namespace. Reports when pod states change (new pod, crash, recovery). Silent when stable.

**Requires:** `kubectl`, `jq`

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

**Config:**
```json
{ "command": "./watch-pods.sh", "interval": 10 }
```

**State:** Stores the full pod state snapshot. Only fires when any pod's phase, readiness, or restart count changes.

---

## GitLab Pipeline Monitor

Polls GitLab API for the latest pipeline. Reports when a pipeline reaches a terminal state (success, failed, canceled).

**Requires:** `curl`, `jq`, env vars `GITLAB_TOKEN` and `GITLAB_PROJECT_ID`

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

**Config:**
```json
{ "command": "./check-pipeline.sh", "interval": 30 }
```

**Prerequisites:**
```bash
export GITLAB_TOKEN="glpat-xxxxxxxxxxxx"
export GITLAB_PROJECT_ID="12345"
```

**State:** Stores the last reported pipeline ID. Only fires on completed pipelines, skips ones still running.

---

## Kubernetes Deployment Rollout

Watches a deployment rollout. Reports when rollout is progressing, stuck, or complete.

**Requires:** `kubectl`, `jq`

```bash
#!/bin/bash
DEPLOYMENT="${1:-myapp}"
NAMESPACE="${2:-default}"
STATE_FILE="/tmp/hh-rollout-${DEPLOYMENT}"

STATUS=$(kubectl rollout status deployment/$DEPLOYMENT -n $NAMESPACE --timeout=1s 2>&1)
EXIT_CODE=$?

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

**Config:**
```json
{ "command": "./watch-deployment.sh myapp default", "interval": 10 }
```

**State:** Stores deployment status snapshot. Reports on any replica count or condition change.

---

## HTTP Health Check

Generic endpoint health monitor. Reports when a service goes down or comes back up.

**Requires:** `curl`

```bash
#!/bin/bash
URL="${1:-http://localhost:8080/health}"
STATE_FILE="/tmp/hh-health-$(echo "$URL" | md5sum | cut -c1-8)"

HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$URL" 2>/dev/null)
if [ -z "$HTTP_CODE" ]; then HTTP_CODE="000"; fi

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  STATUS="healthy"
else
  STATUS="unhealthy"
fi

CURRENT="${STATUS}:${HTTP_CODE}"
LAST=$(cat "$STATE_FILE" 2>/dev/null)

if [ "$CURRENT" = "$LAST" ]; then exit 0; fi

echo "$CURRENT" > "$STATE_FILE"
echo "{\"url\": \"$URL\", \"status\": \"$STATUS\", \"http_code\": $HTTP_CODE}"
```

**Config:**
```json
{ "command": "./health-check.sh http://localhost:8080/health", "interval": 15 }
```

**State:** Stores `status:code`. Only fires on transitions (healthy → unhealthy or vice versa).
