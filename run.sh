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

# mcp: github, slack:write  ->  /mcp/github.read.json /mcp/slack.write.json
MCP_ARGS=()
for entry in ${(s:,:)"$(task_field mcp "$FILE")"}; do
  entry="${entry// /}"
  [[ -n "$entry" ]] || continue
  level=read; [[ "$entry" == *:write ]] && level=write
  cfg="${entry%%:*}.$level.json"
  [[ -f "$DIR/mcp/$cfg" ]] || { echo "Okänd MCP-server i $TASK: $entry (saknar mcp/$cfg)" >&2; exit 1; }
  MCP_ARGS+=("/mcp/$cfg")
done
(( ${#MCP_ARGS} )) && MCP_ARGS=(--mcp-config "${MCP_ARGS[@]}")

WORK="$DIR/work/$TASK"
LOG="$DIR/logs/$TASK/$(date +%Y-%m-%d_%H%M%S).log"
mkdir -p "$WORK" "${LOG:h}" "$DIR/data/slack" "$DIR/data/google"

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
trap 'rm -rf "$LOCK"' EXIT

echo "=== $TASK $(date) ===" >>"$LOG"
set +e
docker run --rm --env-file "$DIR/.env" -e MCP_TIMEOUT=60000 \
  -v "$WORK:/work" \
  -v "$DIR/mcp:/mcp:ro" \
  -v "$DIR/data:/data" \
  "$IMAGE" "${MCP_ARGS[@]}" --strict-mcp-config \
  --dangerously-skip-permissions -p "$PROMPT" >>"$LOG" 2>&1
rc=$?
echo "=== exit $rc ===" >>"$LOG"
exit $rc
