import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import { buildApp } from '../../src/app.js';
import { loadStaticConfig } from '../../src/config/static-config.js';
import { runLighthouse } from '../../src/lighthouse/runner.js';
import { JobQueue } from '../../src/pipeline/jobs.js';
import { createOrchestrator } from '../../src/pipeline/orchestrator.js';
import { PreviewStore } from '../../src/pipeline/state.js';
import { RateLimiter } from '../../src/security/rate-limit.js';
import { assertSafeUrl } from '../../src/security/url-guard.js';
import { startFakeGithub } from './fake-github.mjs';
import { FIXTURES, materialize, serveDirectory } from './fixtures.mjs';

// Acceptance suite: Kanso, end to end, against the real kanso-frontend build.
//
// What is real: the Nuxt build of the landing page, headless Chrome and
// Lighthouse, the Kanso HTTP server and job queue, the forge adapter, the
// .kanso.yml budgets, and the CI client a pipeline would run.
//
// What is stood in: GitHub (./fake-github.mjs, so no PR is touched) and the
// preview host (a local static server with gzip). The AI analysis is off — it
// spends credits and its output is not deterministic.
//
// Each audit is a known-answer test: the landing page as shipped must pass, and
// each deliberately regressed variant must fail on exactly the metric it
// regresses. The steps run in order on a single simulated PR, one push per
// step, the way a real branch evolves, each compared against the unchanged
// build as its reference.
//
//   npm run test:acceptance
//
// Environment:
//   KANSO_FRONTEND_DIR           path to kanso-frontend  (default ../kanso-frontend)
//   KANSO_ACCEPTANCE_SKIP_BUILD  1 to reuse an existing dist/ instead of building
//   KANSO_ACCEPTANCE_RUNS        Lighthouse runs per audit, median kept (default 3)
//   KANSO_ACCEPTANCE_VERBOSE     1 to print Kanso's own logs
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CLIENT = join(REPO_ROOT, 'integrations/kanso-audit.mjs');
const FRONTEND_DIR = resolve(REPO_ROOT, process.env.KANSO_FRONTEND_DIR ?? '../kanso-frontend');
const RUNS = Number(process.env.KANSO_ACCEPTANCE_RUNS ?? 3);

const OWNER = 'acceptance';
const REPO = 'kanso-frontend';
const PR = 1;
const WRITE_TOKEN = 'acceptance-write-token';
const READ_TOKEN = 'acceptance-read-token';

// One push per step. `fails` lists the metrics that must come out as `fail`;
// an empty list means no metric may fail — the false-positive check.
const STEPS = [
  { fixture: 'baseline', label: 'the landing page as shipped passes', fails: [] },
  { fixture: 'tbt', label: 'a main-thread busy loop fails on TBT', fails: ['tbt'] },
  { fixture: 'cls', label: 'a late-inserted block fails on CLS', fails: ['cls'] },
  { fixture: 'lcp', label: 'an unoptimized hero image fails on LCP', fails: ['lcp'] },
  { fixture: 'baseline', label: 'reverting the regressions passes again', fails: [] },
];

const AUDIT_TIMEOUT_MS = 15 * 60_000;

let workDir;
let github;
let kanso;
let queue;
let configPath;
const fixtures = {};

before(async () => {
  await access(join(FRONTEND_DIR, 'package.json')).catch(() => {
    throw new Error(`kanso-frontend not found at ${FRONTEND_DIR} — clone it there or set KANSO_FRONTEND_DIR`);
  });

  if (process.env.KANSO_ACCEPTANCE_SKIP_BUILD !== '1') {
    const build = await run('npm', ['run', 'build'], { cwd: FRONTEND_DIR });
    if (build.code !== 0) throw new Error(`kanso-frontend build failed:\n${build.output.slice(-4000)}`);
  }

  const distDir = join(FRONTEND_DIR, 'dist');
  const index = await readFile(join(distDir, 'index.html'), 'utf8').catch(() => null);
  // The suite audits static files. If the landing stops being prerendered, the
  // build has no index.html and there is nothing to serve.
  if (!index) throw new Error(`${distDir}/index.html is missing — is the landing page still prerendered?`);

  workDir = await mkdtemp(join(tmpdir(), 'kanso-acceptance-'));

  // The repo's real budgets, with the two settings an automated run must not
  // inherit: no AI analysis, and no production reference — the suite never
  // reaches out to kanso.sh.
  const repoConfig = yaml.load(await readFile(join(FRONTEND_DIR, '.kanso.yml'), 'utf8').catch(() => '')) ?? {};
  const testConfig = { ...repoConfig, runs: RUNS, ai_analysis: false };
  delete testConfig.base_url;
  configPath = join(workDir, 'kanso.yml');
  await writeFile(configPath, yaml.dump(testConfig));

  for (const id of new Set(STEPS.map((s) => s.fixture))) {
    const dir = join(workDir, id);
    await materialize(id, distDir, dir);
    fixtures[id] = await serveDirectory(dir);
  }

  github = await startFakeGithub({
    owner: OWNER, repo: REPO, prNumber: PR, writeToken: WRITE_TOKEN, readToken: READ_TOKEN,
  });

  // The URL guard is real, with one scoped exemption: the fixture servers,
  // which have to live on loopback. Any other URL — including every URL the
  // security tests below submit — goes through the production check.
  const fixtureOrigins = new Set(Object.values(fixtures).map((f) => new URL(f.url).origin));
  const verifyUrl = async (url) => {
    if (fixtureOrigins.has(originOf(url))) return;
    return assertSafeUrl(url);
  };

  queue = new JobQueue({ concurrency: 1, maxQueued: 10 });
  const orchestrator = createOrchestrator({
    store: new PreviewStore(),
    staticConfig: loadStaticConfig(join(REPO_ROOT, 'config.yml')),
    runLighthouse,
    gptClient: null,
    verifyUrl,
  });
  kanso = buildApp({
    env: { webhookSecret: 'unused-by-the-api-trigger', runtime: { githubApiUrl: github.url } },
    githubApp: { getInstallationOctokit: async () => { throw new Error('the webhook trigger is not under test'); } },
    store: new PreviewStore(),
    orchestrator,
    queue,
    rateLimiter: new RateLimiter({ capacity: 100, windowMs: 60_000 }),
    verifyUrl,
    logger: process.env.KANSO_ACCEPTANCE_VERBOSE === '1' ? { level: 'info' } : false,
  });
  await kanso.listen({ port: 0, host: '127.0.0.1' });
}, { timeout: 10 * 60_000 });

after(async () => {
  await kanso?.close();
  await github?.close();
  await Promise.all(Object.values(fixtures).map((f) => f.close()));
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

// --- security gates ----------------------------------------------------------
// These run first and must leave no trace: no comment, no status, no audit.

test('a token without write access is refused before any audit', async () => {
  const sha = shaFor('read-only');
  github.push(sha);

  const res = await runClient({ sha, previewUrl: fixtures.baseline.url, token: READ_TOKEN });

  assert.equal(res.code, 1);
  assert.match(res.output, /returned 403/);
  assert.equal(github.state.comments.length, 0, 'a refused caller must not get a comment posted');
  assert.equal(queue.stats().retained, 0, 'a refused caller must not get an audit queued');
});

test('a commit that is no longer the PR head is refused', async () => {
  github.push(shaFor('current-head'));

  const res = await runClient({ sha: shaFor('superseded'), previewUrl: fixtures.baseline.url, token: WRITE_TOKEN });

  assert.equal(res.code, 1);
  assert.match(res.output, /returned 409/);
  assert.equal(queue.stats().retained, 0);
});

test('a preview URL pointing at the cloud metadata service is refused', async () => {
  const sha = shaFor('ssrf');
  github.push(sha);

  const res = await runClient({ sha, previewUrl: 'http://169.254.169.254/latest/meta-data/', token: WRITE_TOKEN });

  assert.equal(res.code, 1);
  assert.match(res.output, /returned 400.*non-public address/);
  assert.equal(queue.stats().retained, 0);
});

test('the security gates left the PR untouched', () => {
  assert.equal(github.state.comments.length, 0);
  assert.equal(github.state.statuses.length, 0);
});

// --- known-answer audits -------------------------------------------------------

for (const [index, step] of STEPS.entries()) {
  test(`${index + 1}. ${step.label}`, { timeout: AUDIT_TIMEOUT_MS }, async (t) => {
    const sha = shaFor(`step-${index}-${step.fixture}`);
    github.push(sha);

    // Every step is compared against the unchanged build, the way a PR is
    // compared against its base. It is what the report needs to tell a finding
    // this push introduced from one the page already carried — the landing page
    // breaks a handful of axe rules, and no step of this suite touches them.
    const res = await runClient({
      sha, previewUrl: fixtures[step.fixture].url, baseUrl: fixtures.baseline.url, token: WRITE_TOKEN,
    });
    const jobId = res.output.match(/job ([0-9a-f-]{36})/)?.[1];
    assert.ok(jobId, `the client did not queue an audit:\n${res.output}`);

    const verdict = await (await fetch(new URL(`/v1/audit/${jobId}`, kansoUrl()))).json();
    t.diagnostic(`${FIXTURES[step.fixture].description} → ${verdict.conclusion ?? verdict.status}`);
    for (const line of describeScores(verdict)) t.diagnostic(line);

    assert.equal(verdict.status, 'done', `audit did not complete: ${verdict.error}`);

    const failing = Object.entries(verdict.statuses ?? {})
      .filter(([, level]) => level === 'fail')
      .map(([metric]) => metric);

    // Findings the reference already has must never fail a push: a repo with
    // existing violations would otherwise be red on every PR, and the report
    // would be read as noise within a week. That holds for every module that
    // reports findings — none of this suite's regressions touches a rule.
    const findings = Object.entries(verdict.modules ?? {})
      .flatMap(([id, result]) => (result.findings ?? []).map((finding) => ({ id, ...finding })));
    assert.ok(
      verdict.modules?.accessibility?.findings?.length > 0,
      'the landing page has axe findings — this is what proves they are inherited, not new'
    );
    assert.deepEqual(
      findings.filter((finding) => finding.level !== 'pass').map((finding) => `${finding.id}: ${finding.rule}`),
      [],
      'a finding the reference already has was held against the push'
    );

    if (step.fails.length === 0) {
      assert.deepEqual(failing, [], `false positive — unchanged page failed on ${failing.join(', ')}`);
      assert.equal(res.code, 0, 'the CI client must exit 0 when nothing fails');
    } else {
      for (const metric of step.fails) {
        assert.ok(
          failing.includes(metric),
          `${metric} regression not detected (failing: ${failing.join(', ') || 'none'}) — ` +
            `if the audit saw it but passed it, the ${metric} budget in kanso-frontend's .kanso.yml is too loose to catch it`
        );
      }
      assert.equal(res.code, 1, 'the CI client must exit 1 so the pipeline fails');
    }

    // The status for this push went pending first, then settled on the verdict.
    const expected = step.fails.length === 0 ? 'success' : 'failure';
    assert.deepEqual(
      github.state.statuses.filter((s) => s.sha === sha).map((s) => s.state),
      ['pending', expected]
    );
  });
}

// --- what the PR ends up with ---------------------------------------------------

test('the PR carries a single report, edited in place on every push', () => {
  assert.equal(github.state.comments.length, 1, 'each push must update the report, not add one');
  assert.ok(github.state.edits >= STEPS.length, `expected at least ${STEPS.length} edits, saw ${github.state.edits}`);

  const body = github.state.comments[0].body;
  assert.match(body, /<!-- kanso:report -->/);
  assert.match(body, /### 📱 Mobile/);
  assert.match(body, /### 💻 Desktop/);
  assert.doesNotMatch(body, /⏳/, 'the placeholder must have been replaced by the final report');
});

test('Kanso called no GitHub endpoint the suite does not model', () => {
  assert.deepEqual(github.state.unexpected, []);
});

// --- helpers --------------------------------------------------------------------

function kansoUrl() {
  const { address, port } = kanso.server.address();
  return `http://${address}:${port}`;
}

function shaFor(label) {
  return createHash('sha1').update(`kanso-acceptance:${label}`).digest('hex');
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Runs the CI client exactly as a pipeline would. The environment is scrubbed
// of CI variables so a run inside GitHub Actions cannot leak the real
// repository, PR or token into the client's defaults.
function runClient({ sha, previewUrl, token, baseUrl = null }) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(GITHUB_|CI_|KANSO_|GITLAB_|PR_NUMBER$)/.test(key))
  );
  return run(process.execPath, [
    CLIENT,
    '--api', kansoUrl(),
    '--token', token,
    '--repo', `${OWNER}/${REPO}`,
    '--pr', String(PR),
    '--sha', sha,
    '--preview-url', previewUrl,
    ...(baseUrl ? ['--base-url', baseUrl] : []),
    '--source', 'Acceptance',
    '--config', configPath,
    '--fail-on', 'fail',
    '--timeout', String(AUDIT_TIMEOUT_MS / 1000),
  ], { cwd: workDir, env });
}

function run(command, args, { cwd, env = process.env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolvePromise({ code, output }));
  });
}

function describeScores(verdict) {
  const lines = [];
  for (const [formFactor, sides] of Object.entries(verdict.scores ?? {})) {
    const s = sides?.pr;
    if (!s) {
      lines.push(`  ${formFactor.padEnd(7)} audit failed`);
      continue;
    }
    lines.push(
      `  ${formFactor.padEnd(7)} perf ${Math.round(s.performance)} · LCP ${Math.round(s.lcp)}ms · ` +
        `TBT ${Math.round(s.tbt)}ms · CLS ${s.cls.toFixed(3)} · FCP ${Math.round(s.fcp)}ms`
    );
  }
  const statuses = Object.entries(verdict.statuses ?? {}).map(([m, l]) => `${m}:${l}`).join(' ');
  if (statuses) lines.push(`  statuses ${statuses}`);
  return lines;
}
