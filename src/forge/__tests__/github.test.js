import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGithubForge } from '../github.js';

// Minimal Octokit stand-in: routes are matched by their template string.
function fakeOctokit(handlers) {
  const calls = [];
  return {
    calls,
    request: async (route, params) => {
      calls.push({ route, params });
      const handler = handlers[route];
      if (!handler) throw Object.assign(new Error(`unexpected route ${route}`), { status: 500 });
      return handler(params);
    },
  };
}

const forgeWith = (handlers) =>
  createGithubForge({ octokit: fakeOctokit(handlers), owner: 'acme', repo: 'site' });

test('requires credentials and a repository', () => {
  assert.throws(() => createGithubForge({ owner: 'acme', repo: 'site' }), /octokit or a token/);
  assert.throws(() => createGithubForge({ token: 't' }), /owner and repo/);
});

test('getPullRequest normalizes the payload', async () => {
  const forge = forgeWith({
    'GET /repos/{owner}/{repo}/pulls/{pull_number}': () => ({
      data: { number: 7, state: 'open', head: { sha: 'deadbee', ref: 'feat' }, base: { ref: 'main' } },
    }),
  });
  assert.deepEqual(await forge.getPullRequest({ prNumber: 7 }), {
    number: 7, state: 'open', headSha: 'deadbee', headRef: 'feat', baseRef: 'main',
  });
});

// Callers branch on null, never on an HTTP status code.
test('a missing or unreadable resource resolves to null', async () => {
  const notFound = () => { throw Object.assign(new Error('nope'), { status: 404 }); };
  const forbidden = () => { throw Object.assign(new Error('nope'), { status: 403 }); };
  assert.equal(await forgeWith({ 'GET /repos/{owner}/{repo}/pulls/{pull_number}': notFound }).getPullRequest({ prNumber: 1 }), null);
  assert.equal(await forgeWith({ 'GET /repos/{owner}/{repo}/contents/{path}': forbidden }).getFileContent({ path: '.kanso.yml' }), null);
});

test('an unexpected error still propagates', async () => {
  const boom = () => { throw Object.assign(new Error('server exploded'), { status: 500 }); };
  await assert.rejects(
    forgeWith({ 'GET /repos/{owner}/{repo}/pulls/{pull_number}': boom }).getPullRequest({ prNumber: 1 }),
    /server exploded/
  );
});

test('findComment locates the marker and stops at the first hit', async () => {
  const forge = forgeWith({
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({
      data: [
        { id: 1, body: 'unrelated' },
        { id: 2, body: 'report <!-- kanso:report --> body' },
      ],
    }),
  });
  assert.equal(await forge.findComment({ prNumber: 3, marker: '<!-- kanso:report -->' }), 2);
});

test('findComment returns null when the marker is absent', async () => {
  const forge = forgeWith({
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({ data: [{ id: 1, body: 'hi' }] }),
  });
  assert.equal(await forge.findComment({ prNumber: 3, marker: '<!-- kanso:report -->' }), null);
});

test('findComment walks pages while they come back full', async () => {
  const pages = {
    1: Array.from({ length: 100 }, (_, i) => ({ id: i, body: 'x' })),
    2: [{ id: 999, body: 'here <!-- kanso:report -->' }],
  };
  const octokit = fakeOctokit({
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': ({ page }) => ({ data: pages[page] ?? [] }),
  });
  const forge = createGithubForge({ octokit, owner: 'acme', repo: 'site' });
  assert.equal(await forge.findComment({ prNumber: 3, marker: '<!-- kanso:report -->' }), 999);
  assert.equal(octokit.calls.length, 2);
});

test('postComment returns the new comment id', async () => {
  const forge = forgeWith({
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments': () => ({ data: { id: 555 } }),
  });
  assert.equal(await forge.postComment({ prNumber: 1, body: 'hello' }), 555);
});

test('setStatus maps the forge vocabulary onto GitHub states', async () => {
  const octokit = fakeOctokit({ 'POST /repos/{owner}/{repo}/statuses/{sha}': () => ({ data: {} }) });
  const forge = createGithubForge({ octokit, owner: 'acme', repo: 'site' });
  await forge.setStatus({ sha: 'abc', state: 'pending', description: 'running' });
  await forge.setStatus({ sha: 'abc', state: 'failure', description: 'regressed' });
  assert.deepEqual(octokit.calls.map((c) => c.params.state), ['pending', 'failure']);
  assert.equal(octokit.calls[0].params.context, 'kanso');
});

test('getFileContent decodes base64 content', async () => {
  const forge = forgeWith({
    'GET /repos/{owner}/{repo}/contents/{path}': () => ({
      data: { content: Buffer.from('budgets:\n  lcp: 2500').toString('base64') },
    }),
  });
  assert.equal(await forge.getFileContent({ path: '.kanso.yml', ref: 'abc' }), 'budgets:\n  lcp: 2500');
});

test('findOpenPullRequestForSha picks the open PR and normalizes it', async () => {
  const forge = forgeWith({
    'GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls': () => ({
      data: [
        { number: 1, state: 'closed', head: { sha: 'x', ref: 'old' }, base: { ref: 'main' } },
        { number: 2, state: 'open', head: { sha: 'y', ref: 'new' }, base: { ref: 'main' } },
      ],
    }),
  });
  assert.deepEqual(await forge.findOpenPullRequestForSha({ sha: 'y' }), {
    number: 2, state: 'open', headSha: 'y', headRef: 'new', baseRef: 'main',
  });
});
