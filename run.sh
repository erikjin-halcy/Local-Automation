#!/bin/zsh
# Kör Claude en gång i Docker med prompten från prompt.md
set -euo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
DIR="${0:A:h}"
IMAGE="claude-runner"
LOG="$DIR/logs/$(date +%Y-%m-%d_%H%M%S).log"
mkdir -p "$DIR/logs"

[[ -f "$DIR/.env" ]] || { echo "Saknar $DIR/.env (kopiera .env.example)" >&2; exit 1; }

# Starta Docker Desktop om den inte är igång
if ! docker info >/dev/null 2>&1; then
  open -a Docker
  for i in {1..60}; do docker info >/dev/null 2>&1 && break; sleep 2; done
fi

# Bygg imagen första gången
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -t "$IMAGE" "$DIR"

{
  echo "=== $(date) ==="
  docker run --rm --env-file "$DIR/.env" \
    -v "$DIR/work:/work" \
    "$IMAGE" -p "$(cat "$DIR/prompt.md")" \
    --dangerously-skip-permissions
} >>"$LOG" 2>&1
