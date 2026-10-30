#!/bin/zsh
# Synkar Apple Notes och Obsidian-valv (sync.json) med molnet var 10:e minut.
# Användning: ./sync/install-sync.sh          ./sync/install-sync.sh --remove
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.local-automation-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$PLIST"; echo "Synken avinstallerad."; exit
fi

NODE="$(command -v node)" || { echo "Hittar inte node" >&2; exit 1; }
command -v gcloud >/dev/null || { echo "Hittar inte gcloud" >&2; exit 1; }
mkdir -p "$DIR/../logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/sync.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${NODE:h}:$(dirname "$(command -v gcloud)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${DIR:h}/logs/sync.log</string>
  <key>StandardErrorPath</key><string>${DIR:h}/logs/sync.log</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Synken körs var 10:e minut. Logg: ${DIR:h}/logs/sync.log"
echo "Första gången frågar macOS om node får styra Notes – svara Tillåt."
