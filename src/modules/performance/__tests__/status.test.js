import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getMetric } from '../metrics.js';
import { buildStatus, evaluateStatuses, metricsWithStatus } from '../status.js';

const inp = getMetric('inp'); // lower is better, good 200, poor 500

test('buildStatus classifies a lower-is-better metric', () => {
  assert.equal(buildStatus(150, null, inp), 'pass');
  assert.equal(buildStatus(300, null, inp), 'warn');
  assert.equal(buildStatus(600, null, inp), 'fail');
});

// A higher-is-better metric reads the other way round, whatever it is.
test('buildStatus classifies a higher-is-better metric', () => {
  const score = { lowerIsBetter: false, good: 90, poor: 49 };
  assert.equal(buildStatus(95, null, score), 'pass');
  assert.equal(buildStatus(70, null, score), 'warn');
  assert.equal(buildStatus(40, null, score), 'fail');
});

test('buildStatus uses an explicit budget as the fail threshold', () => {
  // Without a budget, 300 sits in the warn zone; a budget of 250 makes it a fail.
  assert.equal(buildStatus(300, null, inp), 'warn');
  assert.equal(buildStatus(300, 250, inp), 'fail');
});

test('evaluateStatuses returns a status for every metric measured', () => {
  assert.deepEqual(evaluateStatuses({ inp: 100 }, {}), { inp: 'pass' });
});

// INP where nothing was clicked: a number nobody measured passes nothing and
// fails nothing.
test('a metric with no value gets no status', () => {
  assert.deepEqual(evaluateStatuses({ inp: null }, {}), {});
});

test('metricsWithStatus names the metrics that reached a level, in registry order', () => {
  assert.deepEqual(metricsWithStatus({ inp: 'fail' }, 'fail'), ['inp']);
  assert.deepEqual(metricsWithStatus({ inp: 'fail' }, 'warn'), []);
});
