import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitStatusPayload } from '../commit-status.js';

const passing = { performance: 'pass', lcp: 'pass', tbt: 'pass', cls: 'pass', fcp: 'pass' };

test('all checks passing reports success', () => {
  const payload = commitStatusPayload({ performance: { levels: passing } });
  assert.equal(payload.state, 'success');
  assert.equal(payload.description, 'All checks within acceptable thresholds');
});

test('a warning never blocks the merge', () => {
  const payload = commitStatusPayload({ performance: { levels: { ...passing, lcp: 'warn' } } });
  assert.equal(payload.state, 'success');
  assert.match(payload.description, /Warnings on Performance: LCP — review before merging/);
});

test('a failed metric reports failure and names the metrics', () => {
  const payload = commitStatusPayload({
    performance: { levels: { ...passing, performance: 'fail', lcp: 'warn', tbt: 'fail' } },
  });
  assert.equal(payload.state, 'failure');
  assert.equal(payload.description, 'Failed on Performance: Performance, TBT');
});

// The status is the whole audit's, not performance's: a passing page with a new
// accessibility violation cannot report "all checks within thresholds".
test('every module is named in the status', () => {
  const payload = commitStatusPayload({
    performance: { levels: { ...passing, lcp: 'fail' } },
    accessibility: { levels: { 'color-contrast': 'fail', 'image-alt': 'pass' } },
  });
  assert.equal(payload.state, 'failure');
  assert.equal(payload.description, 'Failed on Performance: LCP · Accessibility: color-contrast');
});

// GitHub cuts the description at 140 characters, so a page failing thirty rules
// still has to say something readable.
test('a long list of failures is clipped to what GitHub shows', () => {
  const levels = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`aria-rule-number-${i}`, 'fail']));
  const payload = commitStatusPayload({ accessibility: { levels } });
  assert.ok(payload.description.length <= 140, payload.description);
  assert.ok(payload.description.endsWith('…'));
});

test('a module with nothing to say is left out', () => {
  const payload = commitStatusPayload({
    performance: { levels: { ...passing, tbt: 'warn' } },
    accessibility: { levels: {} },
  });
  assert.equal(payload.description, 'Warnings on Performance: TBT — review before merging');
});
