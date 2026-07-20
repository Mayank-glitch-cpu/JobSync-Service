# GPU worker for sukhrobnurali/qwen3vl-resume-parser.
# Build:  docker build -t resume-parser-worker .
# Run:    docker run --gpus all -p 8080:8080 -e PARSER_BEARER_TOKEN=... resume-parser-worker
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

# Pre-download weights into the image so cold starts don't pull ~8GB at runtime.
# Comment out to keep the image slim and rely on a mounted HF cache instead.
ARG PREFETCH_WEIGHTS=1
RUN if [ "$PREFETCH_WEIGHTS" = "1" ]; then \
      python -c "from huggingface_hub import snapshot_download; snapshot_download('sukhrobnurali/qwen3vl-resume-parser')"; \
    fi

ENV PORT=8080
EXPOSE 8080
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
