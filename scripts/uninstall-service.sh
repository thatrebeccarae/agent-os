#!/usr/bin/env bash
set -euo pipefail

PLIST_NAME="com.tars.agent.plist"
DEST="$HOME/Library/LaunchAgents/${PLIST_NAME}"

if [ ! -f "$DEST" ]; then
  echo "Service plist not installed at $DEST"
  exit 0
fi

echo "Unloading service..."
launchctl unload "$DEST" 2>/dev/null || true

echo "Removing plist..."
rm -f "$DEST"

echo "Done. Service uninstalled."
