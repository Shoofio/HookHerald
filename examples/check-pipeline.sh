#!/bin/bash
# Check GitLab pipeline status. Notifies on completion (success/failed/canceled).
# Requires: GITLAB_TOKEN, GITLAB_PROJECT_ID
# Usage: add to .hookherald.json watchers:
#   { "command": "./check-pipeline.sh", "interval": 30 }

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
