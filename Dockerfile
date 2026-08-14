# --- Build stage: install dependencies (incl. native better-sqlite3) -------
FROM node:20-bookworm-slim AS deps

# better-sqlite3 ships prebuilt binaries, but keep build tools available as a
# fallback in case a prebuilt binary is unavailable for the target platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Browsers are provided by the Playwright runtime image below, so don't let the
# playwright npm package download them here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev

# --- Runtime stage ---------------------------------------------------------
# The Playwright image ships Chromium + all its OS dependencies. Its version
# must match the "playwright" npm version in package.json (currently 1.62.1).
FROM mcr.microsoft.com/playwright:v1.62.1-jammy AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY scraper ./scraper
COPY public ./public

# Persist the SQLite database and downloaded media outside the image layers.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
