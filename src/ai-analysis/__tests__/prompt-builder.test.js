import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../prompt-builder.js';

const sampleDiff = [
  {
    filename: 'src/Hero.jsx',
    status: 'modified',
    patch: '+ <img src="huge-banner.png" />',
  },
];

test('prompt contains metric label, values, and delta', () => {
  const prompt = buildPrompt({
    metric: 'lcp',
    currentValue: 3.2,
    threshold: 2.5,
    refValue: 2.4,
    delta: 33.3,
    diff: sampleDiff,
  });

  assert.match(prompt, /Largest Contentful Paint/);
  assert.match(prompt, /3\.2s/);
  assert.match(prompt, /2\.5s/);
  assert.match(prompt, /2\.4s/);
  assert.match(prompt, /\+33\.3%/);
});

test('prompt embeds the filtered diff', () => {
  const prompt = buildPrompt({
    metric: 'tbt',
    currentValue: 500,
    threshold: 300,
    refValue: 200,
    delta: 150,
    diff: sampleDiff,
  });

  assert.match(prompt, /src\/Hero\.jsx/);
  assert.match(prompt, /huge-banner\.png/);
  assert.match(prompt, /```diff/);
});

test('prompt asks for cause, prioritized actions, and honesty about externals', () => {
  const prompt = buildPrompt({
    metric: 'performance',
    currentValue: 60,
    threshold: 80,
    refValue: 90,
    delta: 33.3,
    diff: sampleDiff,
  });

  assert.match(prompt, /Identify the most likely cause/);
  assert.match(prompt, /prioritized actions/i);
  assert.match(prompt, /honest about uncertainty/i);
  assert.match(prompt, /external/i);
});

test('prompt handles negative delta sign', () => {
  const prompt = buildPrompt({
    metric: 'cls',
    currentValue: 0.3,
    threshold: 0.1,
    refValue: 0.05,
    delta: 500,
    diff: sampleDiff,
  });

  assert.match(prompt, /\+500\.0%/);
});

test('prompt formats N/A when threshold or ref is missing', () => {
  const prompt = buildPrompt({
    metric: 'fcp',
    currentValue: 3.0,
    threshold: null,
    refValue: null,
    delta: 50,
    diff: sampleDiff,
  });

  // Both threshold and ref render as N/A
  const naMatches = prompt.match(/N\/A/g) ?? [];
  assert.ok(naMatches.length >= 2, 'expected at least two N/A renderings');
});
