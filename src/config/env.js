import { readFileSync } from 'node:fs';

// Reads and validates the process environment, failing fast if a required
// variable is missing. The GitHub App private key is read eagerly here so a
// bad path surfaces at startup rather than on the first webhook.
//
// Accepts the private key either as a raw PEM string (GITHUB_PRIVATE_KEY, for
// cloud deployments where file mounts aren't available) or as a file path
// (GITHUB_PRIVATE_KEY_PATH, for local dev). GITHUB_PRIVATE_KEY takes precedence.
export function loadEnv() {
  const appId = process.env.GITHUB_APP_ID;
  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  const privateKeyRaw = process.env.GITHUB_PRIVATE_KEY;
  const privateKeyPath = process.env.GITHUB_PRIVATE_KEY_PATH;

  if (!appId || !webhookSecret || (!privateKeyRaw && !privateKeyPath)) {
    throw new Error('Missing env vars: GITHUB_APP_ID, GITHUB_WEBHOOK_SECRET, and one of GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_PATH');
  }

  const privateKey = privateKeyRaw
    ? privateKeyRaw.replace(/\\n/g, '\n')
    : readFileSync(privateKeyPath, 'utf8');

  return {
    appId,
    webhookSecret,
    privateKeyPath,
    privateKey,
    port: num(process.env.PORT, 3000),
    runtime: loadRuntimeEnv(),
  };
}

// Capacity and safety knobs for the shared instance. All optional: the defaults
// suit a 4 vCPU container running two audits at a time.
//
// KANSO_ALLOWED_PREVIEW_HOSTS is the one to set in any deployment that sits on
// a network with internal services: it pins the set of hosts Kanso will ever
// fetch, which is the only defence that also holds against DNS rebinding (see
// src/security/url-guard.js). Comma-separated, "*.example.com" wildcards allowed.
function loadRuntimeEnv() {
  return {
    allowedPreviewHosts: process.env.KANSO_ALLOWED_PREVIEW_HOSTS ?? '',
    // Points the forge at a self-hosted GitHub (GitHub Enterprise Server).
    // Operator-level on purpose: a caller must never be able to steer Kanso's
    // outbound API calls at a host of their choosing.
    githubApiUrl: process.env.KANSO_GITHUB_API_URL ?? undefined,
    jobConcurrency: num(process.env.KANSO_JOB_CONCURRENCY, 2),
    maxQueued: num(process.env.KANSO_MAX_QUEUED, 20),
    rateLimitPerMinute: num(process.env.KANSO_RATE_LIMIT_PER_MINUTE, 10),
  };
}

// Coerces an env string to a number, falling back when it is unset or
// malformed — Number('') is 0 and Number('4o') is NaN, both of which would
// otherwise reach the API client silently.
function num(value, fallback) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
