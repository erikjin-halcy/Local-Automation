#!/bin/zsh
# Startar molnagenten automatiskt vid inloggning och håller den igång.
# Användning: ./agent/install-agent.sh          ./agent/install-agent.sh --remove
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.local-automation-agent"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$PLIST"; echo "Agenten avinstallerad."; exit
fi

NODE="$(command -v node)" || { echo "Hittar inte node" >&2; exit 1; }
[[ -d "$DIR/node_modules" ]] || (cd "$DIR" && npm install --no-fund --no-audit)
mkdir -p "${DIR:h}/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/agent.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${DIR:h}/logs/agent.out</string>
  <key>StandardErrorPath</key><string>${DIR:h}/logs/agent.err</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Agenten körs. Logg: logs/agent.out"
