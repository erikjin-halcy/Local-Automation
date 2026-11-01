#!/bin/zsh
# Installerar de lokala sammanfattningarna för local-only-organisationerna (local/run.sh) i launchd:
# körs vid inloggning och var 5:e minut; run.sh avgör om morgonen (från 05:00) eller kvällen (från 20:00)
# ska köras. Användning: ./local/install.sh          ./local/install.sh --remove
set -euo pipefail
DIR="${0:A:h}"
LABEL="com.erikjin.local-automation-local"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOGS="${DIR:h}/data/local-launchd"   # bara start och fel; körningarnas loggar ligger i valven

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$PLIST"; echo "De lokala sammanfattningarna är avinstallerade."; exit
fi

NODE="$(command -v node)" || { echo "Hittar inte node" >&2; exit 1; }
mkdir -p "$LOGS" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/launch.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>StandardOutPath</key><string>$LOGS/launchd.out</string>
  <key>StandardErrorPath</key><string>$LOGS/launchd.err</string>
</dict></plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installerat: vid inloggning och var 5:e minut (morgon från 05:00, kväll från 20:00)."
node "${DIR:h}/cloud/compliance.mjs" orgs | while IFS=$'\t' read -r org vault; do
  [[ -d "$DIR/$org" ]] && echo "  $org -> $vault/Sammanfattningar/"
done
