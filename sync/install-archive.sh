#!/bin/zsh
# Arkiverar avslutade veckor till molnet varje måndag 01:00 (sync/archive.mjs, Firestore-delen körs i molnet 00:30).
# Är Macen avstängd eller sover körs det när den vaknar.
# Användning: ./sync/install-archive.sh          ./sync/install-archive.sh --remove
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.local-automation-archive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$PLIST"; echo "Veckoarkivet avinstallerat."; exit
fi

NODE="$(command -v node)" || { echo "Hittar inte node" >&2; exit 1; }
command -v gcloud >/dev/null || { echo "Hittar inte gcloud" >&2; exit 1; }
mkdir -p "$DIR/../logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/archive.mjs</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${NODE:h}:$(dirname "$(command -v gcloud)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>1</integer><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>${DIR:h}/logs/archive.log</string>
  <key>StandardErrorPath</key><string>${DIR:h}/logs/archive.log</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Veckoarkivet körs måndagar 01:00. Logg: ${DIR:h}/logs/archive.log"
