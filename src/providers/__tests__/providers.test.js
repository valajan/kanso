import { test } from 'node:test';
import assert from 'node:assert/strict';
import netlify from '../netlify.js';
import deploymentStatus from '../deployment-status.js';
import cloudflare from '../cloudflare.js';
import amplify from '../amplify.js';
import railway from '../railway.js';
import { providersForEvent, noMatchResponse } from '../index.js';

const log = { info() {}, warn() {}, error() {} };

function fakeStore() {
  const seen = new Set();
  return { hasSeen: (k) => seen.has(k), markSeen: (k) => seen.add(k) };
}

// --- netlify (status event) -------------------------------------------------

test('netlify resolves a successful Netlify status', async () => {
  const result = await netlify.resolve({
    context: 'netlify/preview',
    state: 'success',
    target_url: 'https://deploy-preview-1.netlify.app',
    sha: 'abc123',
  });
  assert.deepEqual(result, {
    preview: { sha: 'abc123', targetUrl: 'https://deploy-preview-1.netlify.app', source: 'Netlify Preview' },
  });
});

test('netlify ignores a status that is not from Netlify', async () => {
  const result = await netlify.resolve({ context: 'ci/build', state: 'success', target_url: 'x', sha: 'y' });
  assert.deepEqual(result, { ignored: { ok: true, ignored: 'status not from netlify' } });
});

test('netlify ignores a non-success state', async () => {
  const result = await netlify.resolve({ context: 'netlify', state: 'pending', target_url: 'x', sha: 'y' });
  assert.deepEqual(result, { ignored: { ok: true, ignored_state: 'pending' } });
});

// --- deployment_status (Vercel / Render) ------------------------------------

test('deployment-status labels a Vercel deployment', async () => {
  const result = await deploymentStatus.resolve({
    deployment_status: { state: 'success', environment_url: 'https://x.vercel.app' },
    deployment: { sha: 's', environment: 'Preview – vercel' },
  });
  assert.deepEqual(result, {
    preview: { sha: 's', targetUrl: 'https://x.vercel.app', source: 'Vercel Preview' },
  });
});

test('deployment-status labels a Render deployment by its URL', async () => {
  const result = await deploymentStatus.resolve({
    deployment_status: { state: 'success', environment_url: 'https://x.onrender.com' },
    deployment: { sha: 's', environment: 'preview' },
  });
  assert.equal(result.preview.source, 'Render Preview');
});

test('deployment-status ignores Railway, whose target is the dashboard', async () => {
  const result = await deploymentStatus.resolve({
    deployment_status: { state: 'success', target_url: 'https://railway.com/project/x' },
    deployment: { sha: 's', environment: 'production' },
  });
  assert.deepEqual(result, {
    ignored: { ok: true, ignored: 'railway deployment_status (target is dashboard, not preview)' },
  });
});

// --- check_run (Cloudflare / Amplify) ---------------------------------------

test('cloudflare extracts a pages.dev preview URL', async () => {
  const result = await cloudflare.resolve(
    {
      check_run: {
        id: 100,
        app: { name: 'Cloudflare Pages', slug: 'cloudflare-pages' },
        status: 'completed',
        conclusion: 'success',
        output: { summary: 'Deployed to https://abc.pages.dev 🎉' },
        head_sha: 'csha',
      },
    },
    { store: fakeStore(), log }
  );
  assert.deepEqual(result, {
    preview: { sha: 'csha', targetUrl: 'https://abc.pages.dev', source: 'Cloudflare Pages' },
  });
});

test('cloudflare returns null for a check_run that is not its own', async () => {
  const result = await cloudflare.resolve(
    { check_run: { app: { name: 'Other', slug: 'other' }, name: 'lint' } },
    { store: fakeStore(), log }
  );
  assert.equal(result, null);
});

test('cloudflare ignores a non-success conclusion', async () => {
  const result = await cloudflare.resolve(
    { check_run: { id: 1, app: { name: 'cloudflare' }, status: 'completed', conclusion: 'failure' } },
    { store: fakeStore(), log }
  );
  assert.deepEqual(result, { ignored: { ok: true, ignored_conclusion: 'failure' } });
});

test('cloudflare deduplicates a check_run it has already handled', async () => {
  const store = fakeStore();
  const payload = {
    check_run: {
      id: 100,
      app: { name: 'cloudflare' },
      status: 'completed',
      conclusion: 'success',
      output: { summary: 'https://abc.pages.dev' },
      head_sha: 'csha',
    },
  };
  const first = await cloudflare.resolve(payload, { store, log });
  assert.ok(first.preview);
  const second = await cloudflare.resolve(payload, { store, log });
  assert.deepEqual(second, { ignored: { ok: true, ignored: 'duplicate check_run' } });
});

test('amplify extracts an amplifyapp.com preview URL', async () => {
  const result = await amplify.resolve(
    {
      check_run: {
        id: 200,
        app: { name: 'aws' },
        name: 'AWS Amplify Console Web Preview',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://pr-1.abc.amplifyapp.com',
        head_sha: 'asha',
      },
    },
    { store: fakeStore(), log }
  );
  assert.deepEqual(result, {
    preview: { sha: 'asha', targetUrl: 'https://pr-1.abc.amplifyapp.com', source: 'AWS Amplify' },
  });
});

test('amplify returns null for a check_run that is not its own', async () => {
  const result = await amplify.resolve(
    { check_run: { app: { name: 'cloudflare' }, name: 'deploy' } },
    { store: fakeStore(), log }
  );
  assert.equal(result, null);
});

// --- issue_comment (Railway) ------------------------------------------------

test('railway resolves the PR head SHA and preview URL from the bot comment', async () => {
  const octokit = { request: async () => ({ data: { state: 'open', head: { sha: 'rsha' } } }) };
  const result = await railway.resolve(
    {
      action: 'created',
      issue: { number: 7, pull_request: {} },
      comment: { user: { login: 'railway[bot]' }, body: 'Build complete ✅ https://app-pr-7.up.railway.app' },
    },
    { getOctokit: async () => octokit, owner: 'o', repo: 'r', store: fakeStore(), log }
  );
  assert.deepEqual(result, {
    preview: { sha: 'rsha', targetUrl: 'https://app-pr-7.up.railway.app', source: 'Railway' },
  });
});

test('railway ignores comments that are not from the railway bot', async () => {
  const result = await railway.resolve(
    {
      action: 'created',
      issue: { pull_request: {} },
      comment: { user: { login: 'someuser' }, body: '✅ https://x.up.railway.app' },
    },
    { store: fakeStore(), log }
  );
  assert.deepEqual(result, { ignored: { ok: true, ignored: 'not railway bot' } });
});

test('railway ignores a build that has not yet succeeded', async () => {
  const result = await railway.resolve(
    {
      action: 'created',
      issue: { pull_request: {} },
      comment: { user: { login: 'railway' }, body: 'Building...' },
    },
    { store: fakeStore(), log }
  );
  assert.deepEqual(result, { ignored: { ok: true, ignored: 'railway deployment not yet successful' } });
});

// --- registry ---------------------------------------------------------------

test('the registry exposes both check_run providers', () => {
  assert.equal(providersForEvent('check_run').length, 2);
  assert.equal(providersForEvent('status').length, 1);
});

test('noMatchResponse names the check_run providers', () => {
  assert.deepEqual(noMatchResponse('check_run'), {
    ok: true,
    ignored: 'check_run not from cloudflare or amplify',
  });
  assert.deepEqual(noMatchResponse('label'), { ok: true, ignored_event: 'label' });
});
