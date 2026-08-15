# --- Build stage: install dependencies (incl. native better-sqlite3) -------
# Both stages use the SAME Node version so the compiled better-sqlite3 native
# binary (tied to Node's ABI / NODE_MODULE_VERSION) loads at runtime.
FROM node:20-bookworm-slim AS deps

# better-sqlite3 ships prebuilt binaries, but keep build tools available as a
# fallback in case a prebuilt binary is unavailable for the target platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Don't download browsers here; the runtime stage installs Chromium itself.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json ./
RUN npm install --omit=dev

# --- Runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data \
    MEDIA_DIR=/app/media \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY scraper ./scraper
COPY public ./public

# Install Chromium and its OS dependencies for the Instagram backup feature.
# `npx playwright install` pulls the browser build matching the installed
# playwright npm version, so the two never drift apart.
RUN npx playwright install --with-deps chromium \
  && rm -rf /var/lib/apt/lists/*

# Persist the SQLite database and downloaded media outside the image layers.
RUN mkdir -p /app/data /app/media
VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
