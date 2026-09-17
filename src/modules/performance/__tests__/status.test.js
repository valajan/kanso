import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetric } from '../metrics.js';
import { buildStatus, evaluateStatuses, hasStatus, metricsWithStatus } from '../status.js';

const performance = getMetric('performance'); // higher is better, good 90, poor 49
const lcp = getMetric('lcp');                 // lower is better,  good 2500, poor 4000

test('buildStatus classifies a higher-is-better metric', () => {
  assert.equal(buildStatus(95, null, performance), 'pass');
  assert.equal(buildStatus(70, null, performance), 'warn');
  assert.equal(buildStatus(40, null, performance), 'fail');
});

test('buildStatus classifies a lower-is-better metric', () => {
  assert.equal(buildStatus(2000, null, lcp), 'pass');
  assert.equal(buildStatus(3000, null, lcp), 'warn');
  assert.equal(buildStatus(5000, null, lcp), 'fail');
});

test('buildStatus uses an explicit budget as the fail threshold', () => {
  // Without a budget, 75 sits in the warn zone; a budget of 80 makes it a fail.
  assert.equal(buildStatus(75, null, performance), 'warn');
  assert.equal(buildStatus(75, 80, performance), 'fail');
});

test('evaluateStatuses returns a status for every metric', () => {
  const statuses = evaluateStatuses(
    { performance: 95, lcp: 2000, tbt: 100, cls: 0.05, fcp: 1200 },
    {}
  );
  assert.deepEqual(Object.keys(statuses), ['performance', 'lcp', 'tbt', 'cls', 'fcp']);
  assert.ok(Object.values(statuses).every((s) => s === 'pass'));
});

test('hasStatus and metricsWithStatus inspect the status map', () => {
  const statuses = { performance: 'fail', lcp: 'warn', tbt: 'pass', cls: 'fail', fcp: 'pass' };
  assert.equal(hasStatus(statuses, 'warn'), true);
  assert.equal(hasStatus(statuses, 'fail'), true);
  assert.deepEqual(metricsWithStatus(statuses, 'fail'), ['performance', 'cls']);
});
