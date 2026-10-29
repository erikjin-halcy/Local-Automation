#!/bin/zsh
# Användning: ./install.sh 08:00        (varje dag kl 08:00)
#             ./install.sh every 3600   (var 3600:e sekund)
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.claude-runner"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == "every" ]]; then
  SCHEDULE="<key>StartInterval</key><integer>${2:?ange sekunder}</integer>"
else
  TIME="${1:-08:00}"
  SCHEDULE="<key>StartCalendarInterval</key><dict><key>Hour</key><integer>$((10#${TIME%%:*}))</integer><key>Minute</key><integer>$((10#${TIME##*:}))</integer></dict>"
fi

mkdir -p "$DIR/logs" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string></array>
  $SCHEDULE
  <key>StandardOutPath</key><string>$DIR/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$DIR/logs/launchd.err</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installerad: $PLIST"
