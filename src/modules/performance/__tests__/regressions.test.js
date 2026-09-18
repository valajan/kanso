import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignificantRegressions } from '../regressions.js';

// A page already over budget before the change did not regress: only a
// failure clearly worse than the baseline is worth explaining.
test('against a baseline, a failure within 10% of it is not a regression', () => {
  const statuses = { lcp: 'fail', tbt: 'fail' };
  const result = detectSignificantRegressions({
    statuses,
    current: { lcp: 4400, tbt: 1000 },
    reference: { lcp: 4100, tbt: 800 },
    budget: { lcp: 4000 },
    formFactor: 'mobile',
  });

  assert.deepEqual(result.map((r) => r.metric), ['tbt']);
  assert.equal(result[0].delta, 25);
  // No TBT budget set: it failed Lighthouse's "poor" boundary, and says so.
  assert.equal(result[0].threshold, 600);
});

test('against the budgets alone, every failure counts', () => {
  const result = detectSignificantRegressions({
    statuses: { lcp: 'fail', cls: 'pass' },
    current: { lcp: 4100, cls: 0.01 },
    reference: { lcp: 4000 },
    budget: { lcp: 4000 },
    formFactor: 'desktop',
    againstBudgets: true,
  });

  assert.deepEqual(result.map((r) => `${r.metric}|${r.formFactor}|${r.threshold}`), ['lcp|desktop|4000']);
});

test('a lower score is a degradation, and the worst degradation comes first', () => {
  const result = detectSignificantRegressions({
    statuses: { performance: 'fail', lcp: 'fail' },
    current: { performance: 45, lcp: 6000 },
    reference: { performance: 90, lcp: 5000 },
    budget: {},
    formFactor: 'mobile',
  });

  assert.deepEqual(result.map((r) => r.metric), ['performance', 'lcp']);
  assert.equal(result[0].delta, 50);
});
