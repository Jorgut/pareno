#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
swift build -c release --arch arm64 --arch x86_64
APP="$ROOT/Pareno Desktop.app"
VERSION="${PARENO_VERSION:-0.9.12}"
BUILD="${PARENO_BUILD:-13}"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$ROOT/Resources/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/Resources/ParenoMark.png" "$APP/Contents/Resources/ParenoMark.png"
cp "$ROOT/.build/release/ParenoDesktop" "$APP/Contents/MacOS/ParenoDesktop"
mkdir -p "$APP/Contents/Frameworks"
SPARKLE_FRAMEWORK="$ROOT/.build/artifacts/sparkle/Sparkle/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
if [ -d "$SPARKLE_FRAMEWORK" ]; then
  ditto "$SPARKLE_FRAMEWORK" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/ParenoDesktop" 2>/dev/null || true
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Pareno Desktop</string>
  <key>CFBundleDisplayName</key><string>Pareno Desktop</string>
  <key>CFBundleIdentifier</key><string>com.archintera.ParenoDesktop</string>
  <key>CFBundleExecutable</key><string>ParenoDesktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${BUILD}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Pareno Desktop · local-first writing checker</string>
  <key>SUFeedURL</key><string>https://parenowriter.pages.dev/appcast.xml</string>
  <key>SUPublicEDKey</key><string>YjJO3zj/0rCiNM8Ot6BxUlhpjdumsyjTZ3S9NMZ1GXI=</string>
  <key>SUEnableAutomaticChecks</key><false/>
  <key>SUScheduledCheckInterval</key><integer>86400</integer>
</dict>
</plist>
PLIST
SIGN_IDENTITY="${PARENO_SIGN_IDENTITY:-Developer ID Application: hong liang zhu (GB38532D8G)}"
if security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_IDENTITY"; then
  codesign --force --deep --options runtime --sign "$SIGN_IDENTITY" "$APP"
else
  echo "warning: signing identity not found, falling back to ad-hoc" >&2
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
fi
echo "Built $APP"
