import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, parseSlug, validateAuditRequest, ValidationError } from '../validate.js';

const valid = {
  repo: 'acme/site',
  pr: 42,
  sha: 'a'.repeat(40),
  previewUrl: 'https://pr-42.netlify.app',
};

function fieldFor(body) {
  try {
    validateAuditRequest(body);
    return null;
  } catch (err) {
    assert.ok(err instanceof ValidationError);
    return err.field;
  }
}

test('normalizes a valid request', () => {
  const out = validateAuditRequest({ ...valid, source: 'Netlify', baseUrl: 'https://acme.com' });
  assert.equal(out.owner, 'acme');
  assert.equal(out.repo, 'site');
  assert.equal(out.slug, 'acme/site');
  assert.equal(out.pr, 42);
  assert.equal(out.forge, 'github');
  assert.equal(out.source, 'Netlify');
  assert.equal(out.baseUrl, 'https://acme.com');
});

test('accepts snake_case aliases for the URL fields', () => {
  const out = validateAuditRequest({
    repo: 'acme/site', pr: 1, sha: 'abc1234',
    preview_url: 'https://p.example', base_url: 'https://b.example',
  });
  assert.equal(out.previewUrl, 'https://p.example');
  assert.equal(out.baseUrl, 'https://b.example');
});

test('parseSlug keeps nested group paths intact', () => {
  assert.deepEqual(parseSlug('group/sub/project'), {
    owner: 'group/sub', repo: 'project', slug: 'group/sub/project',
  });
});

test('rejects a malformed repo slug', () => {
  assert.equal(fieldFor({ ...valid, repo: 'nope' }), 'repo');
  assert.equal(fieldFor({ ...valid, repo: '' }), 'repo');
  assert.equal(fieldFor({ ...valid, repo: 'acme/si te' }), 'repo');
  assert.equal(fieldFor({ ...valid, repo: 'acme/../etc' }), 'repo');
});

test('rejects a non-positive or non-integer PR number', () => {
  for (const pr of [0, -1, 1.5, 'abc', null]) {
    assert.equal(fieldFor({ ...valid, pr }), 'pr', `pr=${pr} should be rejected`);
  }
});

test('rejects a SHA that is not hex of a plausible length', () => {
  assert.equal(fieldFor({ ...valid, sha: 'zzz' }), 'sha');
  assert.equal(fieldFor({ ...valid, sha: 'abc' }), 'sha');
  assert.equal(fieldFor({ ...valid, sha: 'g'.repeat(40) }), 'sha');
  assert.equal(fieldFor({ ...valid, sha: 'a'.repeat(41) }), 'sha');
});

test('lowercases the SHA so comparisons against the forge are stable', () => {
  assert.equal(validateAuditRequest({ ...valid, sha: 'ABC1234' }).sha, 'abc1234');
});

// `source` is rendered into the comment, so it must not be able to carry markup.
test('rejects a source label containing markup or markdown', () => {
  assert.equal(fieldFor({ ...valid, source: '<img src=x onerror=1>' }), 'source');
  assert.equal(fieldFor({ ...valid, source: '[click](https://evil.example)' }), 'source');
  assert.equal(fieldFor({ ...valid, source: 'Netlify Preview' }), null);
});

test('rejects a body that is not an object', () => {
  assert.equal(fieldFor(null), 'body');
  assert.equal(fieldFor([]), 'body');
  assert.equal(fieldFor('string'), 'body');
});

test('rejects an oversized inline config', () => {
  assert.equal(fieldFor({ ...valid, config: 'x'.repeat(70_000) }), 'config');
  assert.equal(fieldFor({ ...valid, config: 'budgets:\n  lcp: 2500' }), null);
});

test('extractToken requires a bearer header', () => {
  assert.equal(extractToken('Bearer ghs_abc123'), 'ghs_abc123');
  assert.equal(extractToken('bearer ghs_abc123'), 'ghs_abc123');
  for (const header of [undefined, '', 'ghs_abc123', 'Basic abc', `Bearer ${'x'.repeat(600)}`]) {
    assert.throws(() => extractToken(header), ValidationError);
  }
});
