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
    PUID=1000 \
    PGID=1000 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Dependencies change rarely, so copy them first and do the expensive install
# (Chromium download + its OS libraries + gosu) BEFORE the app source below.
# That way editing server.js / public / scraper reuses this cached layer instead
# of re-downloading Chromium on every build. `npx playwright install` pulls the
# browser build matching the installed playwright npm version.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
RUN npx playwright install --with-deps chromium \
  && apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

# Application source — changes often, so it lives AFTER the cached layer above.
COPY server.js db.js zip.js ./
COPY scraper ./scraper
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/data /app/media

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Entrypoint fixes ownership then drops from root to PUID:PGID before running.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
