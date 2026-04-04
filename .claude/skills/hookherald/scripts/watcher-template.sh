#!/bin/bash
# HookHerald watcher template
# Copy this file, edit the CHECK COMMAND and JSON OUTPUT sections below.
#
# Usage:
#   cp .claude/skills/hookherald/scripts/watcher-template.sh ./my-watcher.sh
#   chmod +x ./my-watcher.sh
#   # Edit, then add to .hookherald.json:
#   #   { "command": "./my-watcher.sh", "interval": 30 }

# --- CONFIG ---
# Give your watcher a unique name (used for the state file)
WATCHER_NAME="my-watcher"
STATE_FILE="/tmp/hh-${WATCHER_NAME}-state"

# --- CHECK COMMAND ---
# Replace this with whatever you want to monitor.
# The output of this command becomes the "current state" that gets compared
# against the last known state. Use -c with jq to get compact JSON.
#
# Examples:
#   CURRENT=$(kubectl get pods -n default -o json | jq -c '[.items[] | {name: .metadata.name, phase: .status.phase}]')
#   CURRENT=$(docker inspect nginx 2>/dev/null | jq -c '.[0] | {status: .State.Status, health: .State.Health.Status}')
#   CURRENT=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health)
#   CURRENT=$(gh run list --repo owner/repo --limit 1 --json status,conclusion | jq -c '.[0]')
CURRENT=$(echo "replace-me")

# --- DEDUP ---
# Don't touch this section. It ensures we only notify on state changes.
if [ -z "$CURRENT" ]; then exit 0; fi

LAST=$(cat "$STATE_FILE" 2>/dev/null)
if [ "$CURRENT" = "$LAST" ]; then exit 0; fi

echo "$CURRENT" > "$STATE_FILE"

# --- JSON OUTPUT ---
# Format the output as structured JSON for Claude.
# Replace this with fields relevant to your use case.
#
# If CURRENT is already JSON, you can pipe it through jq:
#   echo "$CURRENT" | jq '{ pods: ., summary: { total: (. | length) } }'
#
# If CURRENT is a simple value, build JSON manually:
#   echo "{\"status\": \"$CURRENT\", \"checked_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
echo "$CURRENT"
