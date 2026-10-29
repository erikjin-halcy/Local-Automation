#!/bin/zsh
# Installerar eller uppdaterar molnkörningen i Google Cloud:
#   Artifact Registry + Cloud Build (image), Secret Manager (tokens från .env),
#   Cloud Run Job (kör uppgifter), Cloud Run-tjänst (API för webbappen),
#   Cloud Scheduler (scheman), och deployar webbappen.
# Kan köras om; varje steg hoppar över det som redan finns.
# Användning: ./cloud/deploy.sh din@gmail.com
set -euo pipefail
DIR="${0:A:h:h}"
cd "$DIR"
P="$(python3 -c 'import json;print(json.load(open(".firebaserc"))["projects"]["default"])')"
OWNER="${1:?Ange din Google-adress: $0 din@gmail.com}"
REGION=europe-north2
SCHEDULER_REGION=europe-west1
REPO=local-automation
IMAGE="$REGION-docker.pkg.dev/$P/$REPO/claude-runner:latest"
JOB=claude-task
SERVICE=la-api
G=(gcloud --project "$P" --quiet)
env_get() { sed -n "s/^$1=//p" .env | head -1; }
sa() { echo "$1@$P.iam.gserviceaccount.com"; }

echo "▶ Artifact Registry"
"${G[@]}" artifacts repositories describe "$REPO" --location "$REGION" >/dev/null 2>&1 ||
  "${G[@]}" artifacts repositories create "$REPO" --location "$REGION" --repository-format docker

echo "▶ Servicekonton"
for a in la-build la-runner la-api la-scheduler; do
  "${G[@]}" iam service-accounts describe "$(sa $a)" >/dev/null 2>&1 ||
    "${G[@]}" iam service-accounts create "$a" --display-name "Local Automation ($a)" >/dev/null
done
for role in roles/datastore.user; do
  for a in la-runner la-api; do
    "${G[@]}" projects add-iam-policy-binding "$P" --member "serviceAccount:$(sa $a)" --role "$role" --condition None >/dev/null
  done
done
"${G[@]}" projects add-iam-policy-binding "$P" --member "serviceAccount:$(sa la-api)" --role roles/cloudscheduler.admin --condition None >/dev/null
"${G[@]}" iam service-accounts add-iam-policy-binding "$(sa la-scheduler)" --member "serviceAccount:$(sa la-api)" --role roles/iam.serviceAccountUser >/dev/null

# Cloud Build med eget konto: läsa källkoden, pusha imagen, skriva byggloggar
BUCKET="gs://${P}_cloudbuild"
gcloud storage buckets describe "$BUCKET" --project "$P" >/dev/null 2>&1 || gcloud storage buckets create "$BUCKET" --project "$P" --location "$REGION" >/dev/null
gcloud storage buckets add-iam-policy-binding "$BUCKET" --member "serviceAccount:$(sa la-build)" --role roles/storage.objectViewer >/dev/null
"${G[@]}" artifacts repositories add-iam-policy-binding "$REPO" --location "$REGION" --member "serviceAccount:$(sa la-build)" --role roles/artifactregistry.writer >/dev/null
"${G[@]}" projects add-iam-policy-binding "$P" --member "serviceAccount:$(sa la-build)" --role roles/logging.logWriter --condition None >/dev/null

echo "▶ Bygger image i Cloud Build (några minuter)"
"${G[@]}" builds submit --config cloud/cloudbuild.yaml --substitutions "_IMAGE=$IMAGE" \
  --service-account "projects/$P/serviceAccounts/$(sa la-build)" --gcs-source-staging-dir "$BUCKET/source" . >/dev/null

echo "▶ Hemligheter i Secret Manager"
put_secret() {  # put_secret <namn> <fil>
  "${G[@]}" secrets describe "$1" >/dev/null 2>&1 || "${G[@]}" secrets create "$1" --replication-policy automatic >/dev/null
  local cur new
  cur="$("${G[@]}" secrets versions access latest --secret "$1" 2>/dev/null | shasum | cut -c1-40 || true)"
  new="$(shasum < "$2" | cut -c1-40)"
  [[ "$cur" == "$new" ]] || "${G[@]}" secrets versions add "$1" --data-file "$2" >/dev/null
  "${G[@]}" secrets add-iam-policy-binding "$1" --member "serviceAccount:$(sa la-runner)" --role roles/secretmanager.secretAccessor >/dev/null
}
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT; chmod 700 "$TMP"
SECRETS=()
for pair in CLAUDE_CODE_OAUTH_TOKEN:la-claude-token SLACK_XOXP:la-slack GITHUB_PAT:la-github \
            GOOGLE_OAUTH_CLIENT_ID:la-google-client-id GOOGLE_OAUTH_CLIENT_SECRET:la-google-client-secret \
            LINEAR_API_KEY:la-linear; do
  var="${pair%%:*}"; name="${pair##*:}"; val="$(env_get "$var")"
  [[ -n "$val" ]] || { echo "  hoppar över $var (tom i .env)"; continue; }
  printf '%s' "$val" > "$TMP/v"; put_secret "$name" "$TMP/v"
  SECRETS+=("${var}=${name}:latest")
done
for pair in google:GOOGLE_EMAIL google-work:GOOGLE_WORK_EMAIL; do
  dir="${pair%%:*}"; email="$(env_get "${pair##*:}")"
  f="data/$dir/$email.json"
  [[ -n "$email" && -f "$f" ]] || { echo "  hoppar över $dir (ingen inloggning)"; continue; }
  put_secret "la-$dir-creds" "$f"
  SECRETS+=("/secrets/$dir/creds.json=la-$dir-creds:latest")
done

echo "▶ Cloud Run Job ($JOB)"
"${G[@]}" run jobs deploy "$JOB" --region "$REGION" --image "$IMAGE" \
  --service-account "$(sa la-runner)" --tasks 1 --max-retries 0 --task-timeout 1800s \
  --cpu 1 --memory 2Gi \
  --set-env-vars "GOOGLE_EMAIL=$(env_get GOOGLE_EMAIL),GOOGLE_WORK_EMAIL=$(env_get GOOGLE_WORK_EMAIL)" \
  --set-secrets "${(j:,:)SECRETS}" >/dev/null
for a in la-api la-scheduler; do
  "${G[@]}" run jobs add-iam-policy-binding "$JOB" --region "$REGION" \
    --member "serviceAccount:$(sa $a)" --role roles/run.jobsExecutorWithOverrides >/dev/null
done

echo "▶ Cloud Run-tjänst ($SERVICE)"
"${G[@]}" run deploy "$SERVICE" --region "$REGION" --image "$IMAGE" \
  --service-account "$(sa la-api)" --command node --args /app/api.mjs \
  --cpu 1 --memory 512Mi --max-instances 2 --no-invoker-iam-check \
  --set-env-vars "PROJECT=$P,REGION=$REGION,SCHEDULER_REGION=$SCHEDULER_REGION,JOB=$JOB,SCHEDULER_SA=$(sa la-scheduler),OWNER_EMAIL=$OWNER" >/dev/null
API_URL="$("${G[@]}" run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
printf "// Genereras av cloud/deploy.sh\nexport const apiUrl = '%s';\n" "$API_URL" > ui/public/cloud-config.js
echo "  $API_URL"

echo "▶ Status och webbapp"
TOKEN="$(gcloud auth print-access-token)" node cloud/write-status.mjs "$P"
npx --yes firebase-tools@15 deploy --only hosting --project "$P" --non-interactive >/dev/null

echo "▶ Synkar scheman"
curl -sf -X POST "$API_URL/sync" -H "Authorization: Bearer $(gcloud auth print-identity-token)" || { echo "  synk misslyckades"; exit 1; }
echo
echo "Klart. Jobben körs nu i Cloud Run. Webbappen: https://$P.web.app"
