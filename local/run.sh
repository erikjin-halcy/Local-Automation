#!/bin/zsh
# Organisationer med compliance local-only (compliance.json och devctl) får sina sammanfattningar
# bara på Macen: Claude i Docker (../run.sh), och resultatet stannar i organisationens valv. Inget går till
# Firestore, webbappen, bucketen eller mejl. Körs av launchd vid inloggning och var 5:e minut (install.sh)
# och gör bara något när dagens körning saknas, för varje organisation med en mapp local/<org>/:
#   morgon.md  från 05:00 (första gången Macen är vaken och online)   -> <valv>/Sammanfattningar/<datum> morgon.md
#   kvall.md   från 20:00                                            -> <valv>/Sammanfattningar/<datum> kväll.md
# Det enda som lämnar Macen är räknarna (bara heltal, local/counts.mjs): de visas i morgonmejlet och på Översikten.
# GitHub: gh-inloggningen på Macen (`gh auth token`) används i stället för GITHUB_PAT i .env, så att molnets
# token aldrig behöver åtkomst till organisationen. Den hämtas för varje körning och skickas bara som
# miljövariabel till containern (docker run -e GITHUB_PAT), aldrig till disk eller loggar.
# Användning: ./local/run.sh             ./local/run.sh <org> morgon|kvall   (kör nu, oavsett tid och stämpel)
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"
DIR="${0:A:h}"
ROOT="${DIR:h}"
MAX_TRIES=3                        # misslyckade försök per dag innan det får vänta till nästa dag
today="$(date +%Y-%m-%d)"; hour="$((10#$(date +%H)))"
typeset -A TITLE=(morgon morgon kvall kväll)

notify() { osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true; }

run() {  # run <org> <valv> <morgon|kvall>
  local org="$1" vault="$2" kind="$3" title="${TITLE[$3]}"
  local slug="${(L)org}" task="${(L)org}-$3"
  local state="$vault/.local-automation"   # dold mapp: arbetsyta, loggar och stämplar, syns inte i Obsidian
  local work="$state/work/$task" logs="$state/logs/$task" stamp="$state/stamp/$kind-$today"
  mkdir -p "$work" "$logs" "$state/stamp" "$vault/Sammanfattningar"
  local pat="$(gh auth token 2>/dev/null)"
  local pass=""; [[ -n "$pat" ]] && { export GITHUB_PAT="$pat"; pass=GITHUB_PAT; } || echo "gh är inte inloggat, GitHub-delen använder GITHUB_PAT i .env" >&2
  unset pat
  rm -f "$work/counts.json"
  local started="$work/.started"; touch "$started"
  ENV_PASS="$pass" TASK_FILE="$DIR/$org/$kind.md" WORK_DIR="$work" LOG_DIR="$logs" "$ROOT/run.sh" "$task"
  local rc=$?
  unset GITHUB_PAT
  # Rapporten som skrevs under körningen. Somnar Macen mitt i körningen kan dygnet ha bytts när Claude
  # skriver den, och då har filen det nya datumet; rapporten sparas under det datum den gäller.
  local report=( "$work/$task-"<->-<->-<->.md(N.om) ) day
  report=( ${^report}(Ne:'[[ $REPLY -nt $started ]]':) )
  rm -f "$started"
  if (( rc == 0 )) && (( ${#report} )) && [[ -s "$report[1]" ]]; then
    day="${report[1]:t:r}"; day="${day[-10,-1]}"
    cp "$report[1]" "$vault/Sammanfattningar/$day $title.md"
    touch "$stamp.done" "$state/stamp/$kind-$day.done"
    node "$DIR/counts.mjs" "$org" "$kind" "$work/counts.json" "$day" "$day $title.md" || echo "räknarna sparades inte" >&2
    notify "$org $title" "Klar: Sammanfattningar/$day $title.md i $org-valvet"
    echo "klar: $vault/Sammanfattningar/$day $title.md"
    return 0
  fi
  (( rc == 75 )) && return 0   # körs redan
  echo $(( $(cat "$stamp.tries" 2>/dev/null || echo 0) + 1 )) > "$stamp.tries"
  notify "$org $title" "Misslyckades (exit $rc), se .local-automation/logs/$task"
  return 1
}

due() {  # due <valv> <morgon|kvall> <från timme>
  local stamp="$1/.local-automation/stamp/$2-$today"
  [[ ! -e "$stamp.done" ]] && (( hour >= $3 )) && (( $(cat "$stamp.tries" 2>/dev/null || echo 0) < MAX_TRIES ))
}

typeset -A VAULTS
while IFS=$'\t' read -r org vault; do
  [[ -n "$org" && -d "$DIR/$org" ]] && VAULTS[$org]="$vault"
done < <(node "$ROOT/cloud/compliance.mjs" orgs)

# Manuellt: kör direkt
if (( $# )); then
  [[ -n "${VAULTS[${1:-}]:-}" && "${2:-}" == (morgon|kvall) ]] || { echo "Användning: $0 <${(kj:|:)VAULTS}> morgon|kvall" >&2; exit 2; }
  [[ -d "${VAULTS[$1]}" ]] || { echo "Hittar inte valvet: ${VAULTS[$1]}" >&2; exit 1; }
  run "$1" "${VAULTS[$1]}" "$2"; exit
fi

# Automatiskt: bara när Macen är online (Claude, Slack, Gmail …)
curl -s -o /dev/null -m 10 https://api.anthropic.com || exit 0
for org vault in "${(@kv)VAULTS}"; do
  [[ -d "$vault" ]] || { echo "$org: hittar inte valvet $vault" >&2; continue; }
  find "$vault/.local-automation/stamp" -type f -mtime +14 -delete 2>/dev/null
  # Morgonen hoppas över om kvällen redan är aktuell och morgonen aldrig blev av
  if [[ -f "$DIR/$org/morgon.md" ]] && due "$vault" morgon 5 && (( hour < 20 )); then run "$org" "$vault" morgon; fi
  if [[ -f "$DIR/$org/kvall.md" ]] && due "$vault" kvall 20; then run "$org" "$vault" kvall; fi
done
exit 0
