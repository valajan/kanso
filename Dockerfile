# Kanso API — Cloud Run image.
#
# Bundles Node 20 + Chromium so the four Lighthouse worker threads (mobile +
# desktop × preview + prod) can each launch their own headless Chrome in
# parallel. Sized for a 4 vCPU / 4Gb Cloud Run service: every worker gets a
# dedicated thread and ~1Gb of headroom.
#
# Deploy:
#   gcloud run deploy kanso-api \
#     --source . \
#     --region <region> \
#     --cpu 4 --memory 4Gi \
#     --port 8080 \
#     --set-env-vars NODE_ENV=production
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
