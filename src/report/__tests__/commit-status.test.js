import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitStatusPayload } from '../commit-status.js';

test('all metrics passing reports success', () => {
  const payload = commitStatusPayload({
    performance: 'pass', lcp: 'pass', tbt: 'pass', cls: 'pass', fcp: 'pass',
  });
  assert.equal(payload.state, 'success');
  assert.equal(payload.description, 'All metrics within acceptable thresholds');
});

test('a warning never blocks the merge', () => {
  const payload = commitStatusPayload({
    performance: 'pass', lcp: 'warn', tbt: 'pass', cls: 'pass', fcp: 'pass',
  });
  assert.equal(payload.state, 'success');
  assert.equal(payload.description, 'Minor regressions — review before merging');
});

test('a failed metric reports failure and names the metrics', () => {
  const payload = commitStatusPayload({
    performance: 'fail', lcp: 'warn', tbt: 'fail', cls: 'pass', fcp: 'pass',
  });
  assert.equal(payload.state, 'failure');
  assert.equal(payload.description, 'Performance regression detected on Performance, TBT');
});
