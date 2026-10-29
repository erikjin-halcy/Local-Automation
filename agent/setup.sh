#!/bin/zsh
# Engångsinstallation av molnversionen i Firebase:
#  1. skapar (eller hittar) webbappen och skriver ui/public/firebase-config.js
#  2. skapar agentens konto (e-post/lösenord) och sparar det i .env
#  3. genererar firestore.rules med ditt Google-konto och agentens uid
#  4. deployar databasregler, index och webbappen
# Kräver: npx firebase-tools login, samt Google + Email/Password påslaget i Authentication.
# Användning: ./agent/setup.sh [din-google-epost]
set -euo pipefail
DIR="${0:A:h:h}"
cd "$DIR"
PROJECT="$(python3 -c 'import json;print(json.load(open(".firebaserc"))["projects"]["default"])')"
OWNER="${1:-$(gcloud config get-value account 2>/dev/null)}"
FB=(npx --yes firebase-tools@15 --project "$PROJECT")
AGENT_EMAIL="agent@local-automation.example.com"
[[ "$OWNER" == *@* ]] || { echo "Ange din Google-adress: $0 din@gmail.com" >&2; exit 1; }
echo "Projekt: $PROJECT   Ägare: $OWNER"

# 1. Webbappen
APP_ID="$("${FB[@]}" apps:list WEB --json | python3 -c 'import json,sys;a=json.load(sys.stdin).get("result",[]);print(a[0]["appId"] if a else "")')"
if [[ -z "$APP_ID" ]]; then
  APP_ID="$("${FB[@]}" apps:create WEB "Local Automation" --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["appId"])')"
fi
"${FB[@]}" apps:sdkconfig WEB "$APP_ID" --json | python3 -c '
import json,sys
c=json.load(sys.stdin)["result"]
c=c.get("sdkConfig",c)
keys=["apiKey","authDomain","projectId","storageBucket","messagingSenderId","appId"]
cfg={k:c[k] for k in keys if k in c}
open("ui/public/firebase-config.js","w").write("// Genereras av agent/setup.sh. Webbkonfigurationen är inte hemlig;\n// åtkomst styrs av firestore.rules.\nexport const firebaseConfig = "+json.dumps(cfg,indent=2)+";\n")
'
API_KEY="$(python3 -c 'import re;print(re.search(r"\"apiKey\": \"([^\"]+)\"",open("ui/public/firebase-config.js").read()).group(1))')"
echo "✓ webbapp $APP_ID"

# 2. Agentens konto
touch .env
if ! grep -q '^FIREBASE_AGENT_PASSWORD=.' .env; then
  sed -i '' '/^FIREBASE_AGENT_EMAIL=/d;/^FIREBASE_AGENT_PASSWORD=/d' .env
  printf 'FIREBASE_AGENT_EMAIL=%s\nFIREBASE_AGENT_PASSWORD=%s\n' "$AGENT_EMAIL" "$(openssl rand -base64 33 | tr -d '/+=\n')" >> .env
fi
PASSWORD="$(sed -n 's/^FIREBASE_AGENT_PASSWORD=//p' .env)"
auth() {
  curl -s "https://identitytoolkit.googleapis.com/v1/accounts:$1?key=$API_KEY" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$AGENT_EMAIL\",\"password\":\"$PASSWORD\",\"returnSecureToken\":true}"
}
RESP="$(auth signInWithPassword)"
[[ "$RESP" == *localId* ]] || RESP="$(auth signUp)"
AGENT_UID="$(print -r -- "$RESP" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("localId") or "FEL: "+d.get("error",{}).get("message",""))')"
[[ "$AGENT_UID" != FEL* ]] || { echo "Kunde inte skapa agentens konto: $AGENT_UID (är Email/Password påslaget i Authentication?)" >&2; exit 1; }
echo "✓ agentkonto $AGENT_UID"

# 3. Databasregler
sed -e "s/__OWNER_EMAIL__/$OWNER/" -e "s/__AGENT_UID__/$AGENT_UID/" firestore.rules.template > firestore.rules
echo "✓ firestore.rules"

# 4. Deploy
"${FB[@]}" deploy --only firestore,hosting --non-interactive
echo
echo "Klart. Webbappen: https://$PROJECT.web.app"
echo "Starta agenten:   ./agent/install-agent.sh"
