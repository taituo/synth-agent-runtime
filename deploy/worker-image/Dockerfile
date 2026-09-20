# The Temporal worker image (the runtime).
#
# Build from the repository root:
#   docker build -f deploy/worker-image/Dockerfile -t registry.example/synth-temporal-worker:0.4.0 .
#
# The integration imports the root `src/`, so the integration build emits a
# deterministic nested layout under integrations/temporal/dist (rootDir is the
# repository root). The entry point is therefore:
#   integrations/temporal/dist/integrations/temporal/src/worker-entry.js
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci && npm run build

WORKDIR /app/integrations/temporal
COPY integrations/temporal/package.json integrations/temporal/package-lock.json ./
COPY integrations/temporal/tsconfig.json ./
COPY integrations/temporal/src ./src
COPY integrations/temporal/supervisor ./supervisor
RUN npm ci && npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# The integration dist already carries its compiled copy of the root src it
# imports (see the nested layout note above).
COPY --from=build /app/integrations/temporal/dist ./integrations/temporal/dist
COPY --from=build /app/integrations/temporal/node_modules ./integrations/temporal/node_modules
COPY --from=build /app/package.json ./package.json
USER 10001:10001
CMD ["node", "integrations/temporal/dist/integrations/temporal/src/worker-entry.js"]
