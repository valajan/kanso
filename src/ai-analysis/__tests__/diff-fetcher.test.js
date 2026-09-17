import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAddedLines,
  fetchRelevantDiff,
  isRelevantFile,
  truncatePatch,
} from '../diff-fetcher.js';

test('isRelevantFile keeps frontend extensions', () => {
  assert.equal(isRelevantFile('src/foo.jsx'), true);
  assert.equal(isRelevantFile('src/foo.tsx'), true);
  assert.equal(isRelevantFile('styles/main.scss'), true);
  assert.equal(isRelevantFile('app/Page.svelte'), true);
  assert.equal(isRelevantFile('components/Card.vue'), true);
  assert.equal(isRelevantFile('public/index.html'), true);
});

test('isRelevantFile rejects unrelated extensions', () => {
  assert.equal(isRelevantFile('README.md'), false);
  assert.equal(isRelevantFile('image.png'), false);
  assert.equal(isRelevantFile('data.json'), false);
  assert.equal(isRelevantFile(''), false);
  assert.equal(isRelevantFile(null), false);
});

test('isRelevantFile rejects test, spec, config, and lockfiles', () => {
  assert.equal(isRelevantFile('foo.test.js'), false);
  assert.equal(isRelevantFile('src/foo.spec.ts'), false);
  assert.equal(isRelevantFile('vite.config.js'), false);
  assert.equal(isRelevantFile('jest.config.ts'), false);
  assert.equal(isRelevantFile('package-lock.json'), false);
  assert.equal(isRelevantFile('yarn.lock'), false);
  assert.equal(isRelevantFile('pnpm-lock.yaml'), false);
});

test('truncatePatch caps to maxLines and signals truncation', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `+ line ${i}`).join('\n');
  const out = truncatePatch(lines, 150);
  const outLines = out.split('\n');
  assert.equal(outLines.length, 151); // 150 kept + 1 truncation marker
  assert.match(out, /50 more lines truncated/);
});

test('truncatePatch returns the patch unchanged when under the cap', () => {
  const small = '+ a\n- b\n+ c';
  assert.equal(truncatePatch(small, 150), small);
});

test('fetchRelevantDiff returns null when no relevant files', async () => {
  const forge = {
    getPullRequestFiles: async () => [
      { filename: 'README.md', patch: '+ doc' },
      { filename: 'image.png', patch: null },
      { filename: 'package-lock.json', patch: '+ deps' },
    ],
  };
  const result = await fetchRelevantDiff({ forge, prNumber: 1 });
  assert.equal(result, null);
});

test('fetchRelevantDiff filters, truncates, and forwards the PR number', async () => {
  const longPatch = Array.from({ length: 1100 }, (_, i) => `+ line ${i}`).join('\n');
  let received = null;

  const forge = {
    getPullRequestFiles: async (args) => {
      received = args;
      return [
        { filename: 'src/Hero.jsx', status: 'modified', patch: '+ <img />' },
        { filename: 'src/Hero.test.jsx', status: 'modified', patch: '+ test code' },
        { filename: 'styles/big.css', status: 'modified', patch: longPatch },
        { filename: 'docs/notes.md', status: 'added', patch: '+ note' },
      ];
    },
  };

  const result = await fetchRelevantDiff({ forge, prNumber: 42 });

  assert.deepEqual(received, { prNumber: 42 });

  assert.equal(result.length, 2);
  assert.equal(result[0].filename, 'src/Hero.jsx');
  assert.equal(result[1].filename, 'styles/big.css');
  assert.match(result[1].patch, /more lines truncated/);
});

test('extractAddedLines returns new-side line numbers for + and context lines', () => {
  const patch = [
    '@@ -10,3 +10,5 @@',
    ' context A',
    '-removed',
    '+added at 11',
    '+added at 12',
    ' context B',
  ].join('\n');
  assert.deepEqual(extractAddedLines(patch), [10, 11, 12, 13]);
});

test('extractAddedLines handles multiple hunks and skips file headers', () => {
  const patch = [
    '@@ -1,1 +1,2 @@',
    ' ctx',
    '+ first add at 2',
    '@@ -50,2 +60,3 @@',
    ' ctx',
    '-removed',
    '+ second add at 61',
    '+ third add at 62',
  ].join('\n');
  assert.deepEqual(extractAddedLines(patch), [1, 2, 60, 61, 62]);
});

test('extractAddedLines ignores "no newline at end of file" markers', () => {
  const patch = [
    '@@ -1,1 +1,1 @@',
    '-old',
    '+new',
    '\\ No newline at end of file',
  ].join('\n');
  assert.deepEqual(extractAddedLines(patch), [1]);
});

test('extractAddedLines returns empty for null/empty patches', () => {
  assert.deepEqual(extractAddedLines(null), []);
  assert.deepEqual(extractAddedLines(''), []);
});

test('fetchRelevantDiff attaches addedLines to each returned file', async () => {
  const patch = [
    '@@ -1,2 +1,3 @@',
    ' ctx',
    '+ new line at 2',
    ' ctx',
  ].join('\n');
  const forge = {
    getPullRequestFiles: async () => [{ filename: 'src/a.js', status: 'modified', patch }],
  };
  const result = await fetchRelevantDiff({ forge, prNumber: 1 });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].addedLines, [1, 2, 3]);
});

test('fetchRelevantDiff drops files with empty patch after filtering', async () => {
  const forge = {
    getPullRequestFiles: async () => [
      { filename: 'src/empty.js', status: 'renamed', patch: null },
      { filename: 'src/real.js', status: 'modified', patch: '+ x' },
    ],
  };
  const result = await fetchRelevantDiff({ forge, prNumber: 1 });
  assert.equal(result.length, 1);
  assert.equal(result[0].filename, 'src/real.js');
});
