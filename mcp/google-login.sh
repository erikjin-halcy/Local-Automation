#!/bin/zsh
# Engångsinloggning för Gmail + Google Kalender. Körs på Macen (inte i Docker)
# eftersom Google skickar tillbaka webbläsaren till http://localhost:8000.
# Token sparas i data/google och används sedan av alla uppgifter med mcp: google.
set -euo pipefail
DIR="${0:A:h:h}"
set -a; source "$DIR/.env"; set +a
for v in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_EMAIL; do
  [[ -n "${(P)v:-}" ]] || { echo "Fyll i $v i .env först" >&2; exit 1; }
done
mkdir -p "$DIR/data/google"
export GOOGLE_CREDS_DIR="$DIR/data/google"

# Hemligheterna läses från miljön via ${VAR}, så de skrivs aldrig till disk här
CFG="$(mktemp -t google-mcp).json"
trap 'rm -f "$CFG"' EXIT
cat > "$CFG" <<'JSON'
{"mcpServers":{"google":{"command":"uvx","args":["workspace-mcp","--single-user","--tools","gmail","calendar"],
 "env":{"GOOGLE_OAUTH_CLIENT_ID":"${GOOGLE_OAUTH_CLIENT_ID}","GOOGLE_OAUTH_CLIENT_SECRET":"${GOOGLE_OAUTH_CLIENT_SECRET}",
        "USER_GOOGLE_EMAIL":"${GOOGLE_EMAIL}","WORKSPACE_MCP_CREDENTIALS_DIR":"${GOOGLE_CREDS_DIR}"}}}}
JSON

echo "Claude startar nu. Öppna länken den visar, godkänn i webbläsaren och avsluta sedan med /exit."
claude --strict-mcp-config --mcp-config "$CFG" \
  "Anropa verktyget start_google_auth för $GOOGLE_EMAIL (tjänst: gmail) och visa inloggningslänken. När jag har godkänt, verifiera genom att lista mina 3 senaste mejlrubriker och mina kalenderhändelser idag."
