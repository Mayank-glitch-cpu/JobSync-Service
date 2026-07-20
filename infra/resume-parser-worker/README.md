# Resume Parser Worker

Hosts `sukhrobnurali/qwen3vl-resume-parser` (Qwen3-VL fine-tune, 23-field resume
schema baked into the weights) behind a small FastAPI service. JobSync's
`/api/mutu/users/:id/resume` endpoint forwards uploads here via
`src/lib/mutu/parser-client.ts`.

## API

```
POST /parse
  { "filename": "resume.pdf", "content_base64": "<base64>" }
→ { "resume": { ...23-field record... }, "model": "...", "pages": 2 }

GET /healthz
```

Auth: set `PARSER_BEARER_TOKEN`; JobSync sends it from `RESUME_PARSER_TOKEN`.

## Deploy — Cloud Run GPU (recommended, matches existing gcp-deploy.sh setup)

```bash
gcloud builds submit --tag gcr.io/$PROJECT/resume-parser-worker infra/resume-parser-worker

gcloud run deploy resume-parser-worker \
  --image gcr.io/$PROJECT/resume-parser-worker \
  --gpu 1 --gpu-type nvidia-l4 --cpu 4 --memory 16Gi \
  --region us-central1 --no-cpu-throttling \
  --set-env-vars PARSER_BEARER_TOKEN=$TOKEN \
  --timeout 300 --max-instances 1 --min-instances 0
```

Then on the JobSync service:

```bash
RESUME_PARSER_URL=https://resume-parser-worker-....run.app
RESUME_PARSER_TOKEN=$TOKEN
```

Notes: L4 (24GB) comfortably fits the model in bf16. `min-instances 0` scales to
zero; a cold start (weights baked into the image) is ~1–2 min, which the Node
client's 180s timeout absorbs. Pin `max-instances 1` until volume demands more.

## Alternative — HF Inference Endpoint

Deploy the model as a dedicated HF Inference Endpoint (GPU · Nvidia L4), then set
`RESUME_PARSER_URL` to a thin proxy or adapt `parser-client.ts` to the endpoint's
chat-completions payload. The custom worker above is preferred because the
PDF→PNG page conversion lives server-side.

## Local smoke test (GPU box)

```bash
pip install -r requirements.txt
uvicorn main:app --port 8080
curl -s localhost:8080/parse -H 'content-type: application/json' \
  -d "{\"filename\":\"resume.pdf\",\"content_base64\":\"$(base64 -w0 resume.pdf)\"}" | jq .resume
```
