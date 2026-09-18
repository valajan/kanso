#!/usr/bin/env node
// Kanso CI client — zero dependencies, Node 18+.
//
// Posts a preview URL to a Kanso instance, waits for the audit, and exits
// non-zero when the verdict is worse than the configured threshold. The whole
// integration is this one file plus a token, on any CI on any platform: the job
// that deployed the preview already knows its URL, so nothing has to be
// discovered from webhooks.
//
// Usage:
//   node kanso-audit.mjs --preview-url https://pr-42.example.dev
//
// Everything else is read from the environment, which is already populated on
// GitHub Actions and GitLab CI (see the flags below to override any of it).
const HELP = `
kanso-audit — run a Kanso performance audit on a preview deployment

Required:
  --preview-url <url>     The deployed preview to audit
  --api <url>             Kanso instance      (env KANSO_API_URL)
  --token <token>         Forge token with PR write access
                          (env KANSO_TOKEN, GITHUB_TOKEN, GITLAB_TOKEN)

Usually inferred from the CI environment:
  --repo <owner/name>     (env GITHUB_REPOSITORY, CI_PROJECT_PATH)
  --pr <number>           (env PR_NUMBER, CI_MERGE_REQUEST_IID)
  --sha <sha>             (env GITHUB_SHA, CI_COMMIT_SHA)

Optional:
  --base-url <url>        Reference to compare against. Prefer the base branch's
                          own preview over production: comparing a preview to
                          production also measures the difference in hosting.
  --source <label>        Label shown in the report header (default: CI)
  --config <path>         .kanso.yml to send (default: ./.kanso.yml if present)
  --fail-on <level>       fail | warn | never   (default: fail)
  --timeout <seconds>     How long to wait for the verdict (default: 600)
  --no-wait               Fire and forget: exit 0 once the audit is queued
`;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const env = process.env;
const config = {
  api: trimSlash(args['api'] ?? env.KANSO_API_URL),
  token: args['token'] ?? env.KANSO_TOKEN ?? env.GITHUB_TOKEN ?? env.GITLAB_TOKEN,
  repo: args['repo'] ?? env.GITHUB_REPOSITORY ?? env.CI_PROJECT_PATH,
  pr: args['pr'] ?? env.PR_NUMBER ?? env.CI_MERGE_REQUEST_IID ?? prFromGithubRef(env.GITHUB_REF),
  sha: args['sha'] ?? env.GITHUB_SHA ?? env.CI_COMMIT_SHA,
  previewUrl: args['preview-url'],
  baseUrl: args['base-url'],
  source: args['source'] ?? 'CI',
  failOn: args['fail-on'] ?? 'fail',
  timeoutMs: Number(args['timeout'] ?? 600) * 1000,
  wait: args['no-wait'] !== true,
  configPath: args['config'],
};

for (const key of ['api', 'token', 'repo', 'pr', 'sha', 'previewUrl']) {
  if (!config[key]) fail(`Missing ${key}. Run with --help for the available flags.`);
}

const body = {
  repo: config.repo,
  pr: Number(config.pr),
  sha: config.sha,
  previewUrl: config.previewUrl,
  source: config.source,
};
if (config.baseUrl) body.baseUrl = config.baseUrl;

// Reading .kanso.yml here rather than letting Kanso fetch it saves an API call
// and works with a token that has no repository-contents scope.
const repoConfig = await readConfigFile(config.configPath);
if (repoConfig) body.config = repoConfig;

const submitted = await request('POST', `${config.api}/v1/audit`, body);
console.log(`Kanso — audit queued (job ${submitted.jobId}) for ${config.previewUrl}`);

if (!config.wait) process.exit(0);

const result = await poll(`${config.api}${submitted.statusUrl}`);
report(result);

// --- reporting --------------------------------------------------------------

function report(result) {
  if (result.status === 'error') {
    console.error(`Kanso — audit failed: ${result.error}`);
    process.exit(config.failOn === 'never' ? 0 : 1);
  }

  const icon = { pass: '✅', warn: '⚠️', fail: '❌' }[result.conclusion] ?? 'ℹ️';
  console.log(`Kanso — ${icon} ${result.conclusion} (${Math.round((result.durationMs ?? 0) / 1000)}s)`);

  for (const [formFactor, sides] of Object.entries(result.scores ?? {})) {
    if (!sides?.pr) continue;
    const s = sides.pr;
    console.log(
      `  ${formFactor.padEnd(7)} perf ${Math.round(s.performance)} · LCP ${Math.round(s.lcp)}ms · TBT ${Math.round(s.tbt)}ms · CLS ${Number(s.cls).toFixed(2)}`
    );
  }

  for (const [id, mod] of Object.entries(result.modules ?? { performance: { levels: result.statuses } })) {
    const failing = Object.entries(mod?.levels ?? {}).filter(([, level]) => level === 'fail');
    if (failing.length > 0) console.log(`  ${id} failed on: ${failing.map(([check]) => check).join(', ')}`);
  }

  const shouldFail =
    (config.failOn === 'fail' && result.conclusion === 'fail') ||
    (config.failOn === 'warn' && ['fail', 'warn'].includes(result.conclusion));
  process.exit(shouldFail ? 1 : 0);
}

// --- transport --------------------------------------------------------------

async function request(method, url, payload) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${config.token}`,
        ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (err) {
    fail(`Cannot reach Kanso at ${config.api}: ${err.message}`);
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // fall through to the raw-body error below
  }

  if (!res.ok) {
    const detail = json?.message ?? text.slice(0, 200);
    // 429 is capacity, not a defect in the change under test — say so plainly
    // rather than letting it read as a performance failure.
    if (res.status === 429) fail(`Kanso is at capacity (${detail}). Retry shortly.`);
    fail(`Kanso returned ${res.status}: ${detail}`);
  }
  if (!json) fail(`Kanso returned a non-JSON response: ${text.slice(0, 200)}`);
  return json;
}

// Polls the job endpoint, backing off from 2s to 10s: an audit takes minutes,
// so tight polling only adds load without returning the answer any sooner.
async function poll(url) {
  const deadline = Date.now() + config.timeoutMs;
  let delay = 2000;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(10_000, Math.round(delay * 1.5));
    const job = await request('GET', url);
    if (job.status === 'done' || job.status === 'error') return job;
  }
  fail(`Timed out after ${config.timeoutMs / 1000}s waiting for the audit. The report will still be posted to the PR.`);
}

// --- helpers ----------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { out.help = true; continue; }
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

async function readConfigFile(explicitPath) {
  const { readFile } = await import('node:fs/promises');
  const path = explicitPath ?? '.kanso.yml';
  try {
    return await readFile(path, 'utf8');
  } catch {
    if (explicitPath) fail(`Cannot read config file ${explicitPath}`);
    return null;
  }
}

// On a pull_request event GITHUB_REF is "refs/pull/<n>/merge".
function prFromGithubRef(ref) {
  return ref?.match(/^refs\/pull\/(\d+)\//)?.[1];
}

function trimSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(message) {
  console.error(`Kanso — ${message}`);
  process.exit(1);
}
