// Reads the process environment. Every key is optional: the server runs on its
// defaults, and what they are is documented in .env.example.
export function loadEnv() {
  return {
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
