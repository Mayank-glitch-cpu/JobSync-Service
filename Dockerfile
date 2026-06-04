FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile

COPY mcp-server ./mcp-server
RUN pnpm --filter jobsync-mcp build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app

RUN corepack enable

# Install system dependencies for Playwright and Chromium
# We use pnpm dlx to run the exact playwright version installer with system dependencies
RUN apt-get update && \
    apt-get install -y wget gnupg && \
    mkdir -p /ms-playwright && \
    pnpm dlx playwright@1.44.0 install --with-deps chromium && \
    chmod -R 755 /ms-playwright && \
    rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile --prod --filter jobsync-mcp

COPY --from=build /app/mcp-server/dist ./mcp-server/dist

USER node

CMD ["node", "mcp-server/dist/http.js"]
