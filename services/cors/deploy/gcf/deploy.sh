#!/usr/bin/env bash
# Deploys dist/gcf (built by `npm run build`) as a gen2 HTTP Cloud Function.
#   GCP_PROJECT=my-project [GCP_REGION=us-central1] [GCF_NAME=crossferry-cors] npm run deploy:gcf
# Settings come from env.yaml next to this script (gcloud's comma-separated --set-env-vars
# cannot carry values that themselves contain commas).
set -euo pipefail

: "${GCP_PROJECT:?set GCP_PROJECT to your project id}"
REGION="${GCP_REGION:-us-central1}"
NAME="${GCF_NAME:-crossferry-cors}"

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVICE="$(cd "$HERE/../.." && pwd)"

if [ ! -f "$SERVICE/dist/gcf/index.mjs" ]; then
  echo "dist/gcf/index.mjs not found; run 'npm run build' first" >&2
  exit 1
fi

gcloud functions deploy "$NAME" \
  --gen2 \
  --project "$GCP_PROJECT" \
  --region "$REGION" \
  --runtime nodejs22 \
  --source "$SERVICE/dist/gcf" \
  --entry-point cors \
  --trigger-http \
  --allow-unauthenticated \
  --memory 512Mi \
  --timeout 60s \
  --env-vars-file "$HERE/env.yaml"

gcloud functions describe "$NAME" --gen2 --project "$GCP_PROJECT" --region "$REGION" --format 'value(serviceConfig.uri)'
