#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="Pareno Desktop.app"
SIGN_IDENTITY="${PARENO_SIGN_IDENTITY:-Developer ID Application: hong liang zhu (GB38532D8G)}"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
DMG="../dist/ParenoDesktop-${VERSION}.dmg"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/Pareno Desktop.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "Pareno Desktop" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign --force --sign "$SIGN_IDENTITY" "$DMG" >/dev/null 2>&1 || true
echo "$DMG"
shasum -a 256 "$DMG"
