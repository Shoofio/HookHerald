#!/bin/bash
# Watch pods in default namespace. Sends when pod states change, stays silent when stable.
# Usage: add to .hookherald.json watchers:
#   { "command": "./examples/watch-pods.sh", "interval": 10 }

STATE_FILE="/tmp/hh-pods-state"

CURRENT=$(kubectl get pods -n default -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, phase: .status.phase, ready: (.status.containerStatuses // [] | map(.ready) | all), restarts: (.status.containerStatuses // [] | map(.restartCount) | add // 0)}] | sort_by(.name)')

if [ -z "$CURRENT" ] || [ "$CURRENT" = "[]" ]; then
  exit 0
fi

LAST=$(cat "$STATE_FILE" 2>/dev/null)

if [ "$CURRENT" = "$LAST" ]; then
  exit 0
fi

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
