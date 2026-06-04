FROM node:22-slim AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile

COPY mcp-server ./mcp-server
RUN pnpm --filter jobsync-mcp build

FROM node:22-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY mcp-server/package.json ./mcp-server/package.json
COPY legacy/backend/package.json ./legacy/backend/package.json
COPY legacy/frontend/package.json ./legacy/frontend/package.json

RUN pnpm install --frozen-lockfile --prod --filter jobsync-mcp

COPY --from=build /app/mcp-server/dist ./mcp-server/dist

USER node

CMD ["node", "mcp-server/dist/http.js"]
