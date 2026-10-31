# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
# Prisma's query engine needs OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PRISMA_HIDE_UPDATE_MESSAGE=1

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM base AS prod-deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force

# One-off job: applies migrations and loads the demo catalogue.
FROM build AS migrate
USER node
CMD ["sh", "-c", "npx prisma migrate deploy && npm run db:seed"]

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
# The Prisma client and its query engine come from the build stage.
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node

FROM runtime AS api
EXPOSE 3000
CMD ["node", "dist/apps/api/main.js"]

FROM runtime AS worker
EXPOSE 3001
CMD ["node", "dist/apps/worker/main.js"]
