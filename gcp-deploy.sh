#!/usr/bin/env bash
set -e

# Configuration variables
SERVICE_NAME="jobsync-mcp"
REGION="us-central1"

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
  --set-env-vars="JOBSYNC_HEADLESS=true,NODE_ENV=production"

echo "=========================================================="
echo "🎉 Deployment Successful!"
echo "=========================================================="
echo "Important: Please configure your confidential environment variables in the GCP Console"
echo "(Cloud Run -> $SERVICE_NAME -> Edit & Deploy New Revision -> Variables):"
echo "  - JOBSYNC_REMOTE_BEARER_TOKEN : The bearer token to authorize API requests"
echo "  - GCS_BUCKET_NAME             : (Optional) The GCS bucket name to store screenshots"
echo "  - AIRTABLE_API_KEY            : Your Airtable API Key"
echo "  - AIRTABLE_BASE_ID            : Your Airtable Base ID"
echo "=========================================================="
