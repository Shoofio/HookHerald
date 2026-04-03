#!/bin/bash
# Watch a Kubernetes deployment rollout. Reports progress, stuck, or complete.
# Usage: add to .hookherald.json watchers:
#   { "command": "./watch-deployment.sh myapp default", "interval": 10 }

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
