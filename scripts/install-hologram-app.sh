#!/usr/bin/env bash
#
# Installs a desktop launcher that opens the hologram UI in a chromeless
# Chrome window, pointed at a Core you choose.
#
#   ./scripts/install-hologram-app.sh                         # local Core
#   ./scripts/install-hologram-app.sh https://example/hologram/ "JARVIS Core (Remote)"
#
# Why a launcher and not a Chrome PWA: a PWA shim's target lives in Chrome's
# own Web Applications registry, keyed by an extension-style id, and the shim
# is ad-hoc signed. Editing its Info.plist neither repoints it reliably nor
# survives Chrome rewriting the shim. A three-line launcher has no such state.
set -euo pipefail

URL="${1:-http://localhost:4770/hologram/}"
APP_NAME="${2:-JARVIS Core (Local)}"
APP="$HOME/Applications/$APP_NAME.app"
CHROME="/Applications/Google Chrome.app"

if [ ! -d "$CHROME" ]; then
  echo "Google Chrome is not installed at $CHROME." >&2
  exit 1
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.jarvis.hologram.launcher</string>
    <key>CFBundleExecutable</key>
    <string>launch</string>
    <key>CFBundleIconFile</key>
    <string>app</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>LSUIElement</key>
    <true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/sh
# -n forces a new instance so the window opens even when Chrome is already
# running; --app drops the tab strip and omnibox.
exec open -na "Google Chrome" --args --app="$URL"
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"

# Reuse the icon Chrome generated for the old PWA shim when it is still around,
# so the launcher doesn't show up as a blank sheet of paper in the Dock.
OLD_ICON="$HOME/Applications/Chrome Apps.localized/JARVIS Core.app/Contents/Resources/app.icns"
if [ -f "$OLD_ICON" ]; then
  cp "$OLD_ICON" "$APP/Contents/Resources/app.icns"
fi

# Ad-hoc is fine here: the launcher asks for no TCC permission of its own, so
# there is nothing for a rebuild to silently revoke.
codesign --force --sign - "$APP"
touch "$APP"

echo "Installed $APP"
echo "  -> $URL"
