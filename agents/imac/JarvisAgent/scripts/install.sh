#!/bin/bash
#
# Builds the Agent, installs it as ~/Applications/JarvisAgent.app, signs
# it with the stable identity, and (re)installs its launchd service.
#
# Use this instead of hand-running `swift build` + `codesign --sign -`.
# The hand-rolled version silently revokes every macOS permission the
# Agent holds — see scripts/create-signing-identity.sh for why.
#
# Safe to re-run: permissions and the paired credential survive, because
# the signature identity does not change between runs.

set -euo pipefail

IDENTITY_NAME="JARVIS Agent Code Signing"
LABEL="com.jarvis.agent"
APP="$HOME/Applications/JarvisAgent.app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

cd "$(dirname "$0")/.."
PACKAGE_ROOT="$PWD"

"$PACKAGE_ROOT/scripts/create-signing-identity.sh"

echo
echo "Building..."
swift build -c release

# The Agent has to be a real .app bundle, not a bare executable in
# /usr/local/bin: UNUserNotificationCenter refuses to initialise outside
# one, and TCC wants a bundle identifier to hang its grants on.
echo "Installing to $APP..."
mkdir -p "$APP/Contents/MacOS"
cp "$PACKAGE_ROOT/Resources/Info.plist" "$APP/Contents/Info.plist"

# Stop the service before replacing the binary it is executing, so
# launchd doesn't restart the old inode or race the copy.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

cp "$PACKAGE_ROOT/.build/release/JarvisAgent" "$APP/Contents/MacOS/JarvisAgent"

# --identifier is explicit rather than inferred: the identifier is half
# of the designated requirement macOS matches permissions against, and
# letting it be derived from the file name is how it quietly changes.
echo "Signing as \"$IDENTITY_NAME\"..."
codesign --force --sign "$IDENTITY_NAME" --identifier "$LABEL" "$APP"
codesign --verify --strict "$APP"
codesign -d -r- "$APP" 2>&1 | grep '^designated'

sed "s|__JARVIS_AGENT_EXECUTABLE__|$APP/Contents/MacOS/JarvisAgent|" \
  "$PACKAGE_ROOT/Resources/com.jarvis.agent.plist" > "$PLIST"

echo "Starting the launchd service..."
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Running. Follow it with:  tail -f /tmp/jarvis-agent.log"
