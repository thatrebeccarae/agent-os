#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.tars.agent.plist"
SRC="$(cd "$(dirname "$0")/.." && pwd)/config/${PLIST_NAME}"
DEST="$HOME/Library/LaunchAgents/${PLIST_NAME}"

if [ ! -f "$SRC" ]; then
  echo "Error: plist not found at $SRC"
  exit 1
fi

echo "Copying plist to $DEST..."
cp "$SRC" "$DEST"

echo "Loading service..."
launchctl load "$DEST"

echo "Done. Checking status..."
launchctl list | grep com.tars.agent || echo "Service not found in launchctl list — check logs at /tmp/tars-agent.log"
