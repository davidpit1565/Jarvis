#!/usr/bin/env bash
#
# One-command setup: starts JARVIS Core, builds/starts the iMac Agent if
# needed, detects and approves its pairing code automatically, and hands
# control to the interactive chat. Run this from the project root:
#
#   bash scripts/start-everything.sh
#
# No other terminal windows or manual copy/paste required.

set -e
set -m # enable job control in this script so `fg` works below

cd "$(dirname "$0")/.."

echo "== Stopping anything already using port 4770 =="
lsof -ti:4770 | xargs kill -9 2>/dev/null || true
sleep 1

if [ ! -f .env ] || ! grep -q "^ANTHROPIC_API_KEY=.\+" .env 2>/dev/null; then
  echo ""
  echo "ANTHROPIC_API_KEY is not set in .env — set it first, then re-run this script:"
  echo '  bash -c '"'"'read -s -p "Paste your Anthropic API key and press Enter: " KEY; echo; printf "ANTHROPIC_API_KEY=%s\nJARVIS_PORT=4770\nJARVIS_MEMORY_DB_PATH=./data/jarvis-memory.sqlite\n" "$KEY" > .env'"'"''
  exit 1
fi

echo "== Starting JARVIS Core (it will pause here until everything else is ready — that is expected) =="
bun run dev &
CORE_JOB=$!
sleep 3

AGENT_DIR="agents/imac/JarvisAgent"
AGENT_BIN="$AGENT_DIR/.build/debug/JarvisAgent"

if [ ! -f "$AGENT_BIN" ]; then
  echo "== Building the iMac Agent (first run only) =="
  (cd "$AGENT_DIR" && swift build)
fi

echo "== Starting the iMac Agent =="
AGENT_LOG=$(mktemp)
"$AGENT_BIN" > "$AGENT_LOG" 2>&1 &
AGENT_JOB=$!

echo "== Waiting for the Agent to connect (up to 30s) =="
DEVICE_ID=""
CODE=""
for _ in $(seq 1 30); do
  if grep -q "Registration approved" "$AGENT_LOG" 2>/dev/null; then
    echo "Agent already has a valid saved credential — no approval needed."
    break
  fi
  LINE=$(grep -oE "bun run approve-device [A-Za-z0-9-]+ [0-9]+" "$AGENT_LOG" 2>/dev/null | tail -1)
  if [ -n "$LINE" ]; then
    DEVICE_ID=$(echo "$LINE" | awk '{print $4}')
    CODE=$(echo "$LINE" | awk '{print $5}')
    echo "Got a pairing request for device $DEVICE_ID"
    break
  fi
  sleep 1
done

if [ -n "$DEVICE_ID" ] && [ -n "$CODE" ]; then
  echo "== Approving pairing automatically =="
  bun run approve-device "$DEVICE_ID" "$CODE"
  sleep 1
fi

echo ""
echo "=================================================="
echo " Setup complete. Handing control to JARVIS now —"
echo " type your message below and press Enter."
echo " (Agent log: $AGENT_LOG)"
echo "=================================================="
echo ""

fg %1 || {
  echo ""
  echo "Could not hand control to Core automatically. Run this to talk to JARVIS:"
  echo "  fg %1"
  echo "(or, if that fails too, just run: bun run dev)"
}
