#!/usr/bin/env bash
set -e

# Configuration variables
SERVICE_NAME="jobsync-mcp"
REGION="us-central1"
# Firestore location (multi-region or region). Defaults to nam5 (US multi-region).
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"

# Check if project ID is configured in gcloud
PROJECT_ID=$(gcloud config get-value project 2>/dev/null)

if [ -z "$PROJECT_ID" ]; then
  echo "Error: No active GCP project configured in gcloud. Please configure one first by running:"
  echo "  gcloud config set project <YOUR_PROJECT_ID>"
  exit 1
fi

echo "=========================================================="
echo "Deploying $SERVICE_NAME to GCP Project: $PROJECT_ID"
echo "Region: $REGION"
echo "=========================================================="

# Step 0: Provision Firestore (cache + app-state datastore).
# jobsync persists its dedup cache, MCP response cache, and pipeline/profile
# state in Firestore so they survive Cloud Run's ephemeral, scale-to-zero
# filesystem.
echo "Step 0: Ensuring Firestore is provisioned..."
gcloud services enable firestore.googleapis.com --project "$PROJECT_ID"

if ! gcloud firestore databases describe --database='(default)' --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "  Creating native-mode Firestore database in $FIRESTORE_LOCATION..."
  gcloud firestore databases create --location="$FIRESTORE_LOCATION" --project "$PROJECT_ID"
else
  echo "  Firestore (default) database already exists."
fi

# TTL policy so expired response-cache docs are auto-deleted by Firestore.
gcloud firestore fields ttls update expiresAt \
  --collection-group=mcp_cache --enable-ttl --project "$PROJECT_ID" \
  --async >/dev/null 2>&1 || echo "  (TTL policy already configured or pending.)"

# The Cloud Run runtime service account needs Firestore (Datastore) access.
RUNTIME_SA="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$RUNTIME_SA" \
  --role="roles/datastore.user" >/dev/null

# Step 1: Build the docker image using Google Cloud Build
echo "Step 1: Building container image via GCP Cloud Build..."
gcloud builds submit --tag "gcr.io/$PROJECT_ID/$SERVICE_NAME"

# Step 2: Deploy the container to Google Cloud Run
echo "Step 2: Deploying to Google Cloud Run..."
gcloud run deploy "$SERVICE_NAME" \
  --image "gcr.io/$PROJECT_ID/$SERVICE_NAME" \
  --platform managed \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 2Gi \
  --no-cpu-throttling \
  --timeout 900 \
  --set-env-vars="JOBSYNC_HEADLESS=true,NODE_ENV=production,JOBSYNC_STORAGE_BACKEND=firestore,GOOGLE_CLOUD_PROJECT=$PROJECT_ID,JOBSYNC_SINK=elasticsearch,JOBSYNC_ES_URL=https://job-hunt-elasticsearch-274835708611.us-east1.run.app,JOBSYNC_ES_INDEX=jobs_v2,JOBSYNC_ES_EMBEDDINGS=true"

echo "=========================================================="
echo "🎉 Deployment Successful!"
echo "=========================================================="
echo "Important: Please configure your confidential environment variables in the GCP Console"
echo "(Cloud Run -> $SERVICE_NAME -> Edit & Deploy New Revision -> Variables):"
echo "  - JOBSYNC_REMOTE_BEARER_TOKEN : The bearer token to authorize API requests"
echo "  - GCS_BUCKET_NAME             : (Optional) The GCS bucket name to store screenshots"
echo "  - AIRTABLE_API_KEY            : Your Airtable API Key"
echo "  - AIRTABLE_BASE_ID            : Your Airtable Base ID"
echo "  - ANTHROPIC_API_KEY          : Anthropic key for the server-side Search agent"
echo "  - FIREBASE_API_KEY           : Firebase web apiKey for the dashboard"
echo "=========================================================="
