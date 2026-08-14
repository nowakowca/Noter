# --- Build stage: install dependencies (incl. native better-sqlite3) -------
FROM node:20-bookworm-slim AS deps

# better-sqlite3 ships prebuilt binaries, but keep build tools available as a
# fallback in case a prebuilt binary is unavailable for the target platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# --- Runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY public ./public

# Persist the SQLite database outside the image layers.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
