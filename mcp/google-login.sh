#!/bin/zsh
# Engångsinloggning för Gmail + Google Kalender. Körs på Macen (inte i Docker)
# eftersom Google skickar tillbaka webbläsaren till http://localhost.
#   ./mcp/google-login.sh         privat konto (GOOGLE_EMAIL)      -> data/google
#   ./mcp/google-login.sh work    jobbkonto    (GOOGLE_WORK_EMAIL) -> data/google-work
set -euo pipefail
DIR="${0:A:h:h}"
set -a; source "$DIR/.env"; set +a
case "${1:-}" in
  "")   EMAIL_VAR=GOOGLE_EMAIL;      NAME=google;      export GOOGLE_PORT=8000 ;;
  work) EMAIL_VAR=GOOGLE_WORK_EMAIL; NAME=google-work; export GOOGLE_PORT=8001 ;;
  *) echo "Användning: $0 [work]" >&2; exit 1 ;;
esac
for v in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET $EMAIL_VAR; do
  [[ -n "${(P)v:-}" ]] || { echo "Fyll i $v i .env först" >&2; exit 1; }
done
export LOGIN_EMAIL="${(P)EMAIL_VAR}"
mkdir -p "$DIR/data/$NAME"
export GOOGLE_CREDS_DIR="$DIR/data/$NAME"

# Hemligheterna läses från miljön via ${VAR}, så de skrivs aldrig till disk här
CFG="$(mktemp -t google-mcp)"
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<'JSON'
{"mcpServers":{"google":{"command":"uvx","args":["workspace-mcp","--single-user","--tools","gmail","calendar"],
 "env":{"GOOGLE_OAUTH_CLIENT_ID":"${GOOGLE_OAUTH_CLIENT_ID}","GOOGLE_OAUTH_CLIENT_SECRET":"${GOOGLE_OAUTH_CLIENT_SECRET}",
        "USER_GOOGLE_EMAIL":"${LOGIN_EMAIL}","WORKSPACE_MCP_CREDENTIALS_DIR":"${GOOGLE_CREDS_DIR}",
        "WORKSPACE_MCP_PORT":"${GOOGLE_PORT}"}}}}
JSON

echo "Claude startar nu. Öppna länken den visar, godkänn i webbläsaren och avsluta sedan med /exit."
# Prompten måste komma före --mcp-config, som annars tolkar den som en fil
claude "Anropa verktyget start_google_auth för $LOGIN_EMAIL (tjänst: gmail) och visa inloggningslänken. När jag har godkänt, verifiera genom att lista mina 3 senaste mejlrubriker och mina kalenderhändelser idag." \
  --strict-mcp-config --mcp-config "$CFG"
