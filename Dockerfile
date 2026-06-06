FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY dashboard/package.json ./dashboard/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile

COPY mcp-server ./mcp-server
RUN pnpm --filter jobsync-mcp build

# Build the dashboard SPA (served by mcp-server's http.js from ./public).
COPY dashboard ./dashboard
RUN pnpm --filter jobsync-dashboard build

# Pre-download the e5-base-v2 embedding model so Cloud Run cold starts don't
# fetch ~140MB on the first index call. libgomp1 is required by onnxruntime-node.
# Non-fatal: if the warm fails the model just lazy-loads at runtime instead.
ENV HF_HOME=/app/.cache/huggingface
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && \
    rm -rf /var/lib/apt/lists/* && \
    mkdir -p "$HF_HOME" && \
    { node -e "import('@huggingface/transformers').then(async ({pipeline})=>{const p=await pipeline('feature-extraction','Xenova/e5-base-v2');await p('passage: warmup',{pooling:'mean',normalize:true});console.log('e5 model cached');}).catch((e)=>{console.error('e5 warm failed (will lazy-load at runtime):', e && e.message);process.exit(0);})" || echo "e5 warm crashed (native); model will lazy-load at runtime"; }

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY dashboard/package.json ./dashboard/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile --prod --filter jobsync-mcp

# Install the Chromium build that matches the INSTALLED playwright version.
# Driving the install through the locally installed playwright (not a hard-pinned
# `pnpm dlx playwright@x`) guarantees the downloaded browser revision — including
# chrome-headless-shell, which production launches headless — matches
# node_modules/playwright. Pinning the installer to a different version downloads
# the wrong revision and headless launch fails with "Executable doesn't exist".
# libgomp1 is required by onnxruntime-node (e5-base-v2 embeddings).
RUN apt-get update && \
    apt-get install -y wget gnupg libgomp1 && \
    mkdir -p /ms-playwright && \
    pnpm --filter jobsync-mcp exec playwright install --with-deps chromium && \
    chmod -R 755 /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

COPY --from=build /app/mcp-server/dist ./mcp-server/dist
# Dashboard static build served by http.js (PUBLIC_DIR = ./public next to the bundle).
COPY --from=build /app/dashboard/dist ./mcp-server/dist/public

# Bake the pre-downloaded e5 model cache so the runtime never fetches it.
ENV HF_HOME=/home/node/.cache/huggingface
COPY --from=build --chown=node:node /app/.cache/huggingface /home/node/.cache/huggingface

USER node

CMD ["node", "mcp-server/dist/http.js"]
