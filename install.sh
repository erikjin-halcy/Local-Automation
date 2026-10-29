#!/bin/zsh
# Installerar ett launchd-schema för varje uppgift i tasks/ med enabled: true,
# och tar bort scheman för uppgifter som har raderats eller stängts av.
# Användning: ./install.sh        ./install.sh -n  (visa bara, ändra inget)
#             ./install.sh --check "daily 08:00"
set -euo pipefail
DIR="${0:A:h}"
source "$DIR/lib.sh"
PREFIX="com.erikjin.claude-runner"
AGENTS="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
DRY=0; [[ "${1:-}" == "-n" ]] && DRY=1
typeset -A WEEKDAY=(sun 0 mon 1 tue 2 wed 3 thu 4 fri 5 sat 6)

# cal_dict [veckodag] HH:MM
cal_dict() {
  local wd="" t="${@[-1]}"
  (( $# == 2 )) && wd="<key>Weekday</key><integer>$1</integer>"
  echo "<dict>$wd<key>Hour</key><integer>$((10#${t%%:*}))</integer><key>Minute</key><integer>$((10#${t##*:}))</integer></dict>"
}

valid_time() {
  [[ "$1" =~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' ]] || { echo "ogiltig tid '$1'" >&2; return 1; }
}

# schedule_xml "<schedule>" – skriver launchd-XML, returnerar 1 vid fel
schedule_xml() {
  local -a s=(${=1})
  case "${s[1]:-}" in
    every)
      local n="${s[2]:-}" secs
      case "$n" in
        <->[mM]) secs=$(( ${n%?} * 60 )) ;;
        <->[hH]) secs=$(( ${n%?} * 3600 )) ;;
        <->[sS]) secs=${n%?} ;;
        <->)     secs=$n ;;
        *) echo "ogiltigt intervall '$n'" >&2; return 1 ;;
      esac
      (( secs >= 60 )) || { echo "intervallet måste vara minst 60 sekunder" >&2; return 1; }
      echo "<key>StartInterval</key><integer>$secs</integer>" ;;
    daily)
      valid_time "${s[2]:-}" || return 1
      echo "<key>StartCalendarInterval</key>$(cal_dict "${s[2]}")" ;;
    weekdays)
      valid_time "${s[2]:-}" || return 1
      local out="" d
      for d in 1 2 3 4 5; do out+="$(cal_dict $d "${s[2]}")"; done
      echo "<key>StartCalendarInterval</key><array>$out</array>" ;;
    weekly)
      valid_time "${s[3]:-}" || return 1
      local out="" d
      for d in ${(s:,:)s[2]:-}; do
        [[ -n "${WEEKDAY[$d]:-}" ]] || { echo "ogiltig veckodag '$d'" >&2; return 1; }
        out+="$(cal_dict "${WEEKDAY[$d]}" "${s[3]}")"
      done
      echo "<key>StartCalendarInterval</key><array>$out</array>" ;;
    *) echo "okänt schema '$1'" >&2; return 1 ;;
  esac
}

# ./install.sh --check "<schedule>" – validera ett schema utan att installera
if [[ "${1:-}" == "--check" ]]; then
  schedule_xml "${2:-}" >/dev/null
  exit
fi

mkdir -p "$AGENTS"
typeset -A WANTED

for file in "$DIR"/tasks/*.md(N); do
  task="${file:t:r}"
  if [[ ! "$task" =~ '^[A-Za-z0-9_-]+$' ]]; then
    echo "✗ $task: namnet får bara innehålla A–Z, 0–9, - och _" >&2; continue
  fi
  [[ "$(task_field enabled "$file")" == "true" ]] || { echo "– $task: avstängd"; continue; }
  sched="$(task_field schedule "$file")"
  if ! xml="$(schedule_xml "$sched")"; then
    echo "✗ $task: fel i schedule" >&2; continue
  fi

  label="$PREFIX.$task"
  plist="$AGENTS/$label.plist"
  WANTED[$label]=1
  echo "✓ $task: $sched"
  (( DRY )) && continue

  mkdir -p "$DIR/logs/$task"
  cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array><string>$DIR/run.sh</string><string>$task</string></array>
  $xml
  <key>StandardOutPath</key><string>$DIR/logs/$task/launchd.out</string>
  <key>StandardErrorPath</key><string>$DIR/logs/$task/launchd.err</string>
</dict></plist>
PLIST
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$plist"
done

# Ta bort scheman för uppgifter som inte längre finns eller är avstängda
for plist in "$AGENTS/$PREFIX".*.plist(N); do
  label="${plist:t:r}"
  [[ -n "${WANTED[$label]:-}" ]] && continue
  echo "✗ tar bort schema: ${label#$PREFIX.}"
  (( DRY )) && continue
  launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
  rm -f "$plist"
done
