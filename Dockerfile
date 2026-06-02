# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build

WORKDIR /app

ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --prefer-offline --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

COPY . .
RUN npm run verify
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/package-lock.json ./package-lock.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.server-dist ./.server-dist
COPY --from=build --chown=node:node /app/.cache/puppeteer ./.cache/puppeteer

RUN mkdir -p uploads && chown node:node uploads

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "start"]
