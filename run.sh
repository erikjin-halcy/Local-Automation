#!/bin/zsh
# Kör en uppgift från tasks/ en gång i Docker. Användning: ./run.sh <uppgift>
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
DIR="${0:A:h}"
source "$DIR/lib.sh"
IMAGE="claude-runner"

TASK="${1:?Användning: ./run.sh <uppgift>  (se tasks/)}"
FILE="$DIR/tasks/$TASK.md"
[[ -f "$FILE" ]] || { echo "Hittar inte $FILE" >&2; exit 1; }
[[ -f "$DIR/.env" ]] || { echo "Saknar $DIR/.env (kopiera .env.example)" >&2; exit 1; }

PROMPT="$(task_prompt "$FILE")"
[[ -n "${PROMPT//[[:space:]]/}" ]] || { echo "Uppgiften $TASK har ingen prompt" >&2; exit 1; }
# Profilen (vem Claude arbetar åt) läggs först i varje prompt
[[ -s "$DIR/profile.md" ]] && PROMPT="$(cat "$DIR/profile.md")

Uppgift:
$PROMPT"
# Åtgärder i rapporterna blir en checklista som går att bocka av i webbappen
PROMPT="$PROMPT

Format: Om du skriver en rapport till /work, skriv det som kräver svar eller åtgärd från mig som en checklista i markdown, en punkt per sak: \`- [ ] Vad som ska göras (vem det gäller, eventuell deadline)\`. Använd checklistan bara för sådant som faktiskt kräver en åtgärd. Skriv datum som ÅÅÅÅ-MM-DD (t.ex. 2026-10-30), även i rubriker och filnamn."

# mcp: github, slack:write  ->  /mcp/github.read.json /mcp/slack.write.json
# notes och obsidian är inga MCP-servrar utan filer som monteras i containern
MCP_ARGS=()
FILE_MOUNTS=()
FILE_PROMPT=""
for entry in ${(s:,:)"$(task_field mcp "$FILE")"}; do
  entry="${entry// /}"
  [[ -n "$entry" ]] || continue
  level=read; [[ "$entry" == *:write ]] && level=write
  if [[ "${entry%%:*}" == obsidian ]]; then
    ro=":ro"; [[ $level == write ]] && ro=""
    while IFS=$'\t' read -r vname vpath; do
      [[ -d "$vpath" ]] && FILE_MOUNTS+=(-v "$vpath:/obsidian/$vname$ro")
    done < <(node -e 'const c=require(process.argv[1]);for(const[k,v]of Object.entries(c.vaults||{}))console.log(k+"\t"+v.replace(/^~/,process.env.HOME))' "$DIR/sync.json")
    FILE_PROMPT+=$'\n'"Obsidian: mina valv finns i /obsidian/<valv>/.$([[ $level == write ]] && echo ' Du får skapa och ändra markdown-filer; följ valvets struktur och använd [[wikilänkar]].' || echo ' Valven är skrivskyddade.')"
    continue
  fi
  if [[ "${entry%%:*}" == notes ]]; then
    # Lokalt är Notes alltid skrivskyddat; skrivning går via molnet och sync/sync.mjs
    NOTES_DIR="$(mktemp -d)"
    node "$DIR/sync/sync.mjs" export-notes "$NOTES_DIR" >/dev/null
    FILE_MOUNTS+=(-v "$NOTES_DIR:/notes:ro")
    FILE_PROMPT+=$'\n'"Apple Notes: mina anteckningar finns som filer i /notes/<konto>/<mapp>/<titel>.md (skrivskyddade)."
    continue
  fi
  cfg="${entry%%:*}.$level.json"
  [[ -f "$DIR/mcp/$cfg" ]] || { echo "Okänd MCP-server i $TASK: $entry (saknar mcp/$cfg)" >&2; exit 1; }
  MCP_ARGS+=("/mcp/$cfg")
done
(( ${#MCP_ARGS} )) && MCP_ARGS=(--mcp-config "${MCP_ARGS[@]}")
[[ -n "$FILE_PROMPT" ]] && PROMPT="$PROMPT
$FILE_PROMPT"

WORK="$DIR/work/$TASK"
LOG="$DIR/logs/$TASK/$(date +%Y-%m-%d_%H%M%S).log"
mkdir -p "$WORK" "${LOG:h}" "$DIR/data/slack" "$DIR/data/google" "$DIR/data/google-work"

# Starta Docker Desktop om den inte är igång
if ! docker info >/dev/null 2>&1; then
  open -a Docker
  for i in {1..60}; do docker info >/dev/null 2>&1 && break; sleep 2; done
fi

# Bygg imagen första gången och när Dockerfile har ändrats
HASH="$(shasum "$DIR/Dockerfile" | cut -c1-12)"
if [[ "$(docker image inspect -f '{{index .Config.Labels "dockerfile"}}' "$IMAGE" 2>/dev/null)" != "$HASH" ]]; then
  docker build --label "dockerfile=$HASH" -t "$IMAGE" "$DIR" >>"$LOG" 2>&1
fi

# Lås så att samma uppgift inte körs två gånger samtidigt
LOCK="$DIR/logs/$TASK/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "$TASK körs redan" >&2; exit 75
  fi
  rm -rf "$LOCK"; mkdir "$LOCK"
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK" ${NOTES_DIR:+"$NOTES_DIR"}' EXIT

echo "=== $TASK $(date) ===" >>"$LOG"
set +e
# Samma tidszon som Macen, så att "idag" och klockslag stämmer
TZ_NAME="$(readlink /etc/localtime | sed 's#.*/zoneinfo/##')"
docker run --rm --env-file "$DIR/.env" -e MCP_TIMEOUT=60000 -e "TZ=${TZ_NAME:-UTC}" \
  -v "$WORK:/work" \
  -v "$DIR/mcp:/mcp:ro" \
  -v "$DIR/data:/data" \
  "${FILE_MOUNTS[@]}" \
  "$IMAGE" "${MCP_ARGS[@]}" --strict-mcp-config \
  --dangerously-skip-permissions -p "$PROMPT" >>"$LOG" 2>&1
rc=$?
echo "=== exit $rc ===" >>"$LOG"
exit $rc
