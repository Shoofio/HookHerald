#!/usr/bin/env bash
# Watcher script: checks latest GitHub Actions run for Shoofio/HookHerald
# Outputs JSON only when there's something worth reporting (new run or status change)
set -uo pipefail

STATE_FILE="${HH_STATE_DIR:-/tmp}/.hh-ci-last"
REPO="Shoofio/HookHerald"

# Get the latest workflow run
RUN=$(gh run list --repo "$REPO" --limit 1 --json databaseId,status,conclusion,headBranch,event,name,createdAt,url 2>/dev/null)

if [ -z "$RUN" ] || [ "$RUN" = "[]" ]; then
  exit 0
fi

# Extract key fields
RUN_ID=$(echo "$RUN" | jq -r '.[0].databaseId')
STATUS=$(echo "$RUN" | jq -r '.[0].status')
CONCLUSION=$(echo "$RUN" | jq -r '.[0].conclusion // "pending"')
KEY="${RUN_ID}:${STATUS}:${CONCLUSION}"

# Only emit if state changed
LAST=$(cat "$STATE_FILE" 2>/dev/null || echo "")
if [ "$KEY" = "$LAST" ]; then
  exit 0
fi
echo "$KEY" > "$STATE_FILE"

# Output the run info as JSON
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
