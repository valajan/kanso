# Kanso API — Docker image.
#
# Bundles Node 20 + Chromium so Lighthouse worker threads can each launch
# their own headless Chrome in parallel. Sized for 2 vCPU / 2 GB with
# LIGHTHOUSE_CONCURRENCY=3 (~400 MB per Chrome + Node overhead).
# Scale to 4 vCPU / 4 GB to run 4 concurrent audits without throttling.
FROM node:20-slim

# Chromium + the system libs Lighthouse's headless Chrome needs at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

# chrome-launcher picks up CHROME_PATH instead of probing well-known locations.
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=8080

EXPOSE 8080

CMD ["node", "server.js"]
