import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerAuditRoutes } from '../audit-route.js';
import { JobQueue } from '../../pipeline/jobs.js';
import { RateLimiter } from '../../security/rate-limit.js';
import { assertSafeUrl } from '../../security/url-guard.js';

const HEAD_SHA = 'a'.repeat(40);
const AUTH = { authorization: 'Bearer ghs_caller_token' };

// Resolve every hostname to a public address so the guard's DNS step is
// deterministic; literal IPs bypass the resolver and are still judged for real.
const verifyUrl = (url) => assertSafeUrl(url, { resolver: async () => [{ address: '93.184.216.34' }] });

const validBody = {
  repo: 'acme/site',
  pr: 7,
  sha: HEAD_SHA,
  previewUrl: 'https://pr-7.netlify.app',
  source: 'Netlify',
};

function fakeForge(overrides = {}) {
  const forge = {
    kind: 'github',
    slug: 'acme/site',
    posted: [],
    edited: [],
    getPullRequest: async () => ({
      number: 7, state: 'open', headSha: HEAD_SHA, headRef: 'feat-from-forge', baseRef: 'main-from-forge',
    }),
    findComment: async () => null,
    postComment: async ({ body }) => { forge.posted.push(body); return 4242; },
    editComment: async ({ commentId, body }) => { forge.edited.push({ commentId, body }); },
    setStatus: async () => {},
    ...overrides,
  };
  return forge;
}

function buildHarness({ forge = fakeForge(), runReport, queue, rateLimiter } = {}) {
  const calls = [];
  const orchestrator = {
    runReport: runReport ?? (async (args) => {
      calls.push(args);
      return { ok: true, conclusion: 'fail', scores: { mobile: {} }, statuses: { lcp: 'fail' }, commentId: 4242 };
    }),
  };
  const app = Fastify({ logger: false });
  const jobQueue = queue ?? new JobQueue({ concurrency: 2, maxQueued: 10 });
  registerAuditRoutes(app, {
    orchestrator,
    queue: jobQueue,
    rateLimiter: rateLimiter ?? new RateLimiter({ capacity: 100, windowMs: 60_000 }),
    verifyUrl,
    makeForge: () => forge,
  });
  return { app, forge, queue: jobQueue, calls };
}

const post = (app, payload, headers = AUTH) =>
  app.inject({ method: 'POST', url: '/v1/audit', headers, payload });

// --- authentication and input ----------------------------------------------

test('refuses a request with no bearer token', async () => {
  const { app } = buildHarness();
  const res = await post(app, validBody, {});
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_request');
});

test('refuses a malformed body before any forge call', async () => {
  const forge = fakeForge({ getPullRequest: async () => assert.fail('must not reach the forge') });
  const { app } = buildHarness({ forge });
  const res = await post(app, { ...validBody, sha: 'nothex' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().field, 'sha');
});

// --- SSRF -------------------------------------------------------------------

test('refuses a preview URL pointing at the cloud metadata service', async () => {
  const forge = fakeForge({ postComment: async () => assert.fail('must not comment') });
  const { app, queue } = buildHarness({ forge });
  const res = await post(app, { ...validBody, previewUrl: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'url_rejected');
  assert.equal(res.json().reason, 'private_address');
  assert.equal(queue.stats().queued + queue.stats().running, 0);
});

test('refuses a private reference URL just as firmly as a preview URL', async () => {
  const { app } = buildHarness();
  const res = await post(app, { ...validBody, baseUrl: 'http://127.0.0.1:9000/' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'url_rejected');
});

test('refuses a non-http scheme', async () => {
  const { app } = buildHarness();
  const res = await post(app, { ...validBody, previewUrl: 'file:///etc/passwd' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().reason, 'bad_scheme');
});

// --- PR state ---------------------------------------------------------------

test('reports an unknown PR as 404', async () => {
  const { app } = buildHarness({ forge: fakeForge({ getPullRequest: async () => null }) });
  const res = await post(app, validBody);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'pr_not_found');
});

test('refuses to audit a closed PR', async () => {
  const forge = fakeForge({
    getPullRequest: async () => ({ number: 7, state: 'closed', headSha: HEAD_SHA, headRef: 'f', baseRef: 'main' }),
  });
  const { app } = buildHarness({ forge });
  const res = await post(app, validBody);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'pr_not_open');
});

// Auditing a build that HEAD has already moved past would report on the wrong code.
test('refuses a SHA that is no longer the PR head', async () => {
  const { app } = buildHarness();
  const res = await post(app, { ...validBody, sha: 'b'.repeat(40) });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'stale_sha');
});

test('accepts an abbreviated SHA that prefixes the head', async () => {
  const { app } = buildHarness();
  const res = await post(app, { ...validBody, sha: HEAD_SHA.slice(0, 7) });
  assert.equal(res.statusCode, 202);
});

// --- authorization by write probe -------------------------------------------

// The heart of the security model: a caller who cannot write to the PR must not
// be able to spend a single Lighthouse run.
test('a token that cannot comment is refused, and no audit is scheduled', async () => {
  const forge = fakeForge({
    postComment: async () => { throw Object.assign(new Error('Resource not accessible'), { status: 403 }); },
  });
  const { app, queue, calls } = buildHarness({ forge });
  const res = await post(app, validBody);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden');
  await queue.idle();
  assert.equal(calls.length, 0);
  assert.equal(queue.stats().queued + queue.stats().running, 0);
});

// --- happy path -------------------------------------------------------------

test('accepts a valid request, answers 202, and runs the audit in the background', async () => {
  const { app, forge, queue, calls } = buildHarness();
  const res = await post(app, validBody);

  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.ok(['queued', 'running'].includes(body.status));
  assert.equal(body.commentId, 4242);
  assert.equal(body.statusUrl, `/v1/audit/${body.jobId}`);
  // The placeholder went out before the audit was scheduled.
  assert.equal(forge.posted.length, 1);
  assert.match(forge.posted[0], /<!-- kanso:report -->/);

  await queue.idle();
  assert.equal(calls.length, 1);
});

// Nothing the caller writes may reach the rendered comment: the refs come from
// the forge, and the audit is pinned to the forge's head SHA.
test('the audit runs against forge-derived refs, not caller-supplied ones', async () => {
  const { app, queue, calls } = buildHarness();
  await post(app, { ...validBody, headRef: 'injected`](evil)', baseRef: 'injected' });
  await queue.idle();

  assert.equal(calls[0].headRef, 'feat-from-forge');
  assert.equal(calls[0].baseRef, 'main-from-forge');
  assert.equal(calls[0].sha, HEAD_SHA);
  assert.equal(calls[0].previewUrl, 'https://pr-7.netlify.app');
  assert.equal(calls[0].commentId, 4242);
});

test('a re-run edits the existing report instead of stacking a new comment', async () => {
  const forge = fakeForge({ findComment: async () => 999 });
  const { app } = buildHarness({ forge });
  const res = await post(app, validBody);

  assert.equal(res.statusCode, 202);
  assert.equal(res.json().commentId, 999);
  assert.equal(forge.posted.length, 0);
  assert.equal(forge.edited.length, 1);
  assert.equal(forge.edited[0].commentId, 999);
});

test('an inline config is forwarded to the pipeline, sparing a fetch', async () => {
  const { app, queue, calls } = buildHarness();
  await post(app, { ...validBody, config: 'budgets:\n  lcp: 2000\n' });
  await queue.idle();
  assert.equal(calls[0].inlineConfig, 'budgets:\n  lcp: 2000');
});

// --- capacity ---------------------------------------------------------------

test('refuses past the per-repo rate limit with a retry hint', async () => {
  const rateLimiter = new RateLimiter({ capacity: 1, windowMs: 60_000 });
  const { app } = buildHarness({ rateLimiter });
  assert.equal((await post(app, validBody)).statusCode, 202);
  const res = await post(app, validBody);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'rate_limited');
  assert.ok(Number(res.headers['retry-after']) >= 1);
});

test('refuses with 429 when the queue is saturated', async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueued: 1 });
  const runReport = async () => new Promise((r) => setTimeout(() => r({ conclusion: 'pass' }), 40));
  const { app } = buildHarness({ queue, runReport });

  assert.equal((await post(app, validBody)).statusCode, 202); // running
  assert.equal((await post(app, validBody)).statusCode, 202); // waiting
  const res = await post(app, validBody);
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, 'queue_full');
  await queue.idle();
});

// --- job status -------------------------------------------------------------

test('the status endpoint reports the verdict a CI job can fail its build on', async () => {
  const { app, queue } = buildHarness();
  const { jobId } = (await post(app, validBody)).json();
  await queue.idle();

  const res = await app.inject({ method: 'GET', url: `/v1/audit/${jobId}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'done');
  assert.equal(body.conclusion, 'fail');
  assert.deepEqual(body.statuses, { lcp: 'fail' });
  assert.equal(typeof body.durationMs, 'number');
});

test('a failed audit surfaces its error on the status endpoint', async () => {
  const runReport = async () => { throw new Error('chrome would not start'); };
  const { app, queue } = buildHarness({ runReport });
  const { jobId } = (await post(app, validBody)).json();
  await queue.idle();

  const body = (await app.inject({ method: 'GET', url: `/v1/audit/${jobId}` })).json();
  assert.equal(body.status, 'error');
  assert.equal(body.error, 'chrome would not start');
});

test('an unknown job id is a 404', async () => {
  const { app } = buildHarness();
  const res = await app.inject({ method: 'GET', url: '/v1/audit/00000000-0000-4000-8000-000000000000' });
  assert.equal(res.statusCode, 404);
});
