#!/bin/zsh
# Startar webbgränssnittet automatiskt vid inloggning (http://localhost:4777)
# Användning: ./ui/install-ui.sh          ./ui/install-ui.sh --remove
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.local-automation-ui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$PLIST"; echo "Gränssnittet avinstallerat."; exit
fi

NODE="$(command -v node)" || { echo "Hittar inte node" >&2; exit 1; }
mkdir -p "$DIR/../logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DIR:h}/logs/ui.out</string>
  <key>StandardErrorPath</key><string>${DIR:h}/logs/ui.err</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Gränssnittet körs på http://localhost:4777"
