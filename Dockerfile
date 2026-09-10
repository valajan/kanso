# syntax=docker/dockerfile:1
#
# Kanso API — Docker image.
#
# Bundles Node 20 + Chromium so Lighthouse worker threads can each launch
# their own headless Chrome in parallel. Sized for 2 vCPU / 2 GB with
# LIGHTHOUSE_CONCURRENCY=3 (~400 MB per Chrome + Node overhead).
# Scale to 4 vCPU / 4 GB to run 4 concurrent audits without throttling.
FROM node:20-slim

# Chromium + the system libs Lighthouse's headless Chrome needs at runtime.
# dumb-init reaps the orphaned zygote/renderer processes Chromium leaves
# behind: as PID 1, node would never wait() on them and they'd accumulate
# as zombies until the container runs out of PIDs.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

# chrome-launcher picks up CHROME_PATH instead of probing well-known locations.
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

# Installed as root and left root-owned: the unprivileged runtime user below
# only needs to read node_modules, never to write it. The BuildKit cache mount
# keeps npm's download cache out of the image layer while still reusing it
# across builds.
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Copied file by file rather than `COPY . .` so an unrelated file at the repo
# root doesn't invalidate this layer.
COPY server.js config.yml ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080

# Chromium already runs with --no-sandbox, so nothing here needs root.
USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
