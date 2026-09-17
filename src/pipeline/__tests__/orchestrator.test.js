import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrator } from '../orchestrator.js';
import { PreviewStore } from '../state.js';
import { UrlGuardError } from '../../security/url-guard.js';

const log = { info() {}, warn() {}, error() {} };
const GOOD = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
const POOR = { performance: 40, lcp: 6000, tbt: 900, cls: 0.4, fcp: 4000 };
const MEH = { performance: 80, lcp: 3000, tbt: 300, cls: 0.15, fcp: 2000 };

function fakeForge(overrides = {}) {
  const forge = {
    slug: 'acme/site',
    posted: [], edited: [], statuses: [], reviews: [],
    findComment: async () => null,
    postComment: async ({ body }) => { forge.posted.push(body); return 100; },
    editComment: async ({ commentId, body }) => { forge.edited.push({ commentId, body }); },
    setStatus: async (args) => { forge.statuses.push(args); },
    getFileContent: async () => null,
    getPullRequestFiles: async () => [],
    postReview: async (args) => { forge.reviews.push(args); },
    ...overrides,
  };
  return forge;
}

// Records what each audit was asked to measure so the tests can assert on the
// targets rather than on log output.
function fakeRunner(byUrl) {
  const calls = [];
  const run = async (url, opts) => {
    calls.push({ url, ...opts });
    const result = byUrl[url];
    if (result instanceof Error) throw result;
    if (result === undefined) throw new Error(`unexpected audit target ${url}`);
    return result;
  };
  run.calls = calls;
  return run;
}

function build({ runLighthouse, staticConfig = {}, verifyUrl = null, gptClient = null }) {
  return createOrchestrator({
    store: new PreviewStore(),
    staticConfig: { budgets: {}, ...staticConfig },
    runLighthouse,
    gptClient,
    verifyUrl,
  });
}

const baseArgs = (forge) => ({
  forge, prNumber: 7, sha: 'abc1234', headRef: 'feat', baseRef: 'main',
  previewUrl: 'https://preview.example', log,
});

test('audits both form factors on preview and reference, then reports', async () => {
  const runLighthouse = fakeRunner({
    'https://preview.example': GOOD,
    'https://prod.example': GOOD,
  });
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse, staticConfig: { base_url: 'https://prod.example' } });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, true);
  assert.equal(result.conclusion, 'pass');
  assert.deepEqual(
    runLighthouse.calls.map((c) => `${c.url}|${c.formFactor}`).sort(),
    [
      'https://preview.example|desktop', 'https://preview.example|mobile',
      'https://prod.example|desktop', 'https://prod.example|mobile',
    ]
  );
  assert.equal(forge.posted.length, 1);
  assert.match(forge.posted[0], /### 📱 Mobile/);
  assert.match(forge.posted[0], /### 💻 Desktop/);
});

test('the commit status goes pending before the audits and settles afterwards', async () => {
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse: fakeRunner({ 'https://preview.example': GOOD }) });

  await orchestrator.runReport(baseArgs(forge));

  assert.deepEqual(forge.statuses.map((s) => s.state), ['pending', 'success']);
  assert.equal(forge.statuses[1].description, 'All metrics within acceptable thresholds');
});

// The commit status has to reflect the harshest outcome, not an average.
test('the conclusion takes the worst level across form factors', async () => {
  const runLighthouse = async (url, { formFactor }) => (formFactor === 'mobile' ? POOR : GOOD);
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.conclusion, 'fail');
  assert.equal(forge.statuses.at(-1).state, 'failure');
});

test('a warning never blocks the merge', async () => {
  const orchestrator = build({ runLighthouse: fakeRunner({ 'https://preview.example': MEH }) });
  const forge = fakeForge();

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.conclusion, 'warn');
  assert.equal(forge.statuses.at(-1).state, 'success');
});

test('a re-run edits the report it finds by marker instead of posting again', async () => {
  const forge = fakeForge({ findComment: async () => 555 });
  const orchestrator = build({ runLighthouse: fakeRunner({ 'https://preview.example': GOOD }) });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.commentId, 555);
  assert.equal(forge.posted.length, 0);
  assert.equal(forge.edited[0].commentId, 555);
});

test('a caller-supplied comment id is used without a lookup', async () => {
  const forge = fakeForge({ findComment: async () => assert.fail('must not search') });
  const orchestrator = build({ runLighthouse: fakeRunner({ 'https://preview.example': GOOD }) });

  const result = await orchestrator.runReport({ ...baseArgs(forge), commentId: 42 });

  assert.equal(result.commentId, 42);
  assert.equal(forge.edited[0].commentId, 42);
});

// --- the URL guard, applied again at run time -------------------------------

test('a preview URL rejected at run time aborts before any audit', async () => {
  const runLighthouse = fakeRunner({});
  const forge = fakeForge();
  const verifyUrl = async () => { throw new UrlGuardError('private_address', 'resolves to 10.0.0.1'); };
  const orchestrator = build({ runLighthouse, verifyUrl });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, false);
  assert.equal(result.conclusion, 'error');
  assert.equal(runLighthouse.calls.length, 0);
  assert.match(forge.posted[0], /Preview URL rejected/);
});

// A stale base_url in someone's config costs them the comparison column, not
// the whole report.
test('a rejected reference URL degrades to a preview-only report', async () => {
  const runLighthouse = fakeRunner({ 'https://preview.example': GOOD });
  const forge = fakeForge();
  const verifyUrl = async (url) => {
    if (url === 'https://internal.example') throw new UrlGuardError('private_address', 'internal');
  };
  const orchestrator = build({
    runLighthouse, verifyUrl, staticConfig: { base_url: 'https://internal.example' },
  });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, true);
  assert.equal(runLighthouse.calls.length, 2);
  assert.ok(runLighthouse.calls.every((c) => c.url === 'https://preview.example'));
});

// --- audit failures ---------------------------------------------------------

test('a preview that fails on both form factors reports a failed audit', async () => {
  const runLighthouse = async () => { throw new Error('chrome crashed'); };
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, false);
  assert.equal(result.error, 'chrome crashed');
  assert.match(forge.posted[0], /Lighthouse analysis failed/);
  assert.equal(forge.statuses.at(-1).state, 'failure');
});

test('one form factor failing still produces a report for the other', async () => {
  const runLighthouse = async (url, { formFactor }) => {
    if (formFactor === 'desktop') throw new Error('desktop died');
    return GOOD;
  };
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, true);
  assert.match(forge.posted[0], /_Lighthouse audit failed — no results to report._/);
});

// --- configuration ----------------------------------------------------------

test('the configured run count is passed to every audit and clamped', async () => {
  const runLighthouse = fakeRunner({ 'https://preview.example': GOOD });
  const orchestrator = build({ runLighthouse, staticConfig: { runs: 99 } });

  await orchestrator.runReport(baseArgs(fakeForge()));

  assert.ok(runLighthouse.calls.every((c) => c.runs === 5));
});

test('a request-supplied reference overrides the configured one', async () => {
  const runLighthouse = fakeRunner({
    'https://preview.example': GOOD,
    'https://base-preview.example': GOOD,
  });
  const orchestrator = build({ runLighthouse, staticConfig: { base_url: 'https://prod.example' } });

  await orchestrator.runReport({ ...baseArgs(fakeForge()), baseUrl: 'https://base-preview.example' });

  assert.ok(runLighthouse.calls.some((c) => c.url === 'https://base-preview.example'));
  assert.ok(runLighthouse.calls.every((c) => c.url !== 'https://prod.example'));
});

// With every budget set there is nothing a reference audit can add to the
// verdict, so it is skipped and the budgets become the comparison column.
test('a complete budget set skips the reference audit entirely', async () => {
  const runLighthouse = fakeRunner({ 'https://preview.example': GOOD });
  const forge = fakeForge();
  const orchestrator = build({
    runLighthouse,
    staticConfig: {
      base_url: 'https://prod.example',
      budgets: { performance: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800 },
    },
  });

  await orchestrator.runReport(baseArgs(forge));

  assert.equal(runLighthouse.calls.length, 2);
  assert.match(forge.posted[0], /\| Metric \| budgets \| PR \|/);
});

// A partial budget used as the reference column used to crash the renderer on
// the first metric with no budget set.
test('a partial budget set renders without a value for the unset metrics', async () => {
  const runLighthouse = fakeRunner({ 'https://preview.example': GOOD });
  const forge = fakeForge();
  const orchestrator = build({ runLighthouse, staticConfig: { budgets: { lcp: 2500 } } });

  const result = await orchestrator.runReport(baseArgs(forge));

  assert.equal(result.ok, true);
  assert.match(forge.posted[0], /\| CLS \| — \| 0.01 \| — \|/);
});

test('the inline config wins over the repo file, which is then never fetched', async () => {
  const runLighthouse = fakeRunner({ 'https://preview.example': MEH });
  const forge = fakeForge({ getFileContent: async () => assert.fail('must not fetch') });
  const orchestrator = build({ runLighthouse, staticConfig: { budgets: {} } });

  const result = await orchestrator.runReport({
    ...baseArgs(forge),
    inlineConfig: 'budgets:\n  lcp: 1000\n',
  });

  assert.equal(result.conclusion, 'fail');
  assert.equal(result.statuses.lcp, 'fail');
});
