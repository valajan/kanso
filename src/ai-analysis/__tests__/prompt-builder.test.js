import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../prompt-builder.js';

const sampleDiff = [
  {
    filename: 'src/Hero.jsx',
    status: 'modified',
    patch: '+ <img src="huge-banner.png" />',
    addedLines: [12],
  },
];

const singleRegression = [
  { metric: 'lcp', prVal: 3.2, threshold: 2.5, refVal: 2.4, delta: 33.3 },
];

const multiRegressions = [
  { metric: 'lcp', prVal: 3.2, threshold: 2.5, refVal: 2.4, delta: 33.3 },
  { metric: 'fcp', prVal: 2.8, threshold: 2.0, refVal: 1.5, delta: 86.7 },
];

test('prompt contains metric label, values, and delta', () => {
  const prompt = buildPrompt({ regressions: singleRegression, diff: sampleDiff });

  assert.match(prompt, /Largest Contentful Paint/);
  assert.match(prompt, /3\.2s/);
  assert.match(prompt, /2\.5s/);
  assert.match(prompt, /2\.4s/);
  assert.match(prompt, /\+33\.3%/);
});

test('prompt embeds the filtered diff and lists anchorable lines', () => {
  const prompt = buildPrompt({
    regressions: [{ metric: 'tbt', prVal: 500, threshold: 300, refVal: 200, delta: 150 }],
    diff: sampleDiff,
  });

  assert.match(prompt, /src\/Hero\.jsx/);
  assert.match(prompt, /huge-banner\.png/);
  assert.match(prompt, /```diff/);
  assert.match(prompt, /Anchorable lines.*12/);
});

test('prompt requests JSON output with summary + comments schema', () => {
  const prompt = buildPrompt({
    regressions: [{ metric: 'performance', prVal: 60, threshold: 80, refVal: 90, delta: 33.3 }],
    diff: sampleDiff,
  });

  assert.match(prompt, /JSON/);
  assert.match(prompt, /"summary"/);
  assert.match(prompt, /"comments"/);
  assert.match(prompt, /"file"/);
  assert.match(prompt, /"line"/);
  assert.match(prompt, /"body"/);
  assert.match(prompt, /honest about uncertainty/i);
  assert.match(prompt, /external/i);
});

test('prompt instructs the model not to invent file paths or line numbers', () => {
  const prompt = buildPrompt({
    regressions: [{ metric: 'cls', prVal: 0.3, threshold: 0.1, refVal: 0.05, delta: 500 }],
    diff: sampleDiff,
  });

  assert.match(prompt, /Do not invent/i);
  assert.match(prompt, /\+500\.0%/);
});

test('prompt warns the model when a file has no anchorable lines', () => {
  const prompt = buildPrompt({
    regressions: [{ metric: 'fcp', prVal: 3.0, threshold: null, refVal: null, delta: 50 }],
    diff: [{ filename: 'src/Empty.jsx', status: 'modified', patch: ' context', addedLines: [] }],
  });

  assert.match(prompt, /No added lines/);
  const naMatches = prompt.match(/N\/A/g) ?? [];
  assert.ok(naMatches.length >= 2, 'expected at least two N/A renderings');
});

test('prompt lists all regressed metrics when multiple regressions passed', () => {
  const prompt = buildPrompt({ regressions: multiRegressions, diff: sampleDiff });

  assert.match(prompt, /Largest Contentful Paint/);
  assert.match(prompt, /First Contentful Paint/);
  assert.match(prompt, /\+33\.3%/);
  assert.match(prompt, /\+86\.7%/);
});

test('prompt asks model to cover all regressed metrics in summary', () => {
  const prompt = buildPrompt({ regressions: multiRegressions, diff: sampleDiff });

  assert.match(prompt, /all regressed metrics/i);
});
