import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianScores } from '../runner.js';

const score = (performance, lcp, tbt) => ({ performance, lcp, tbt, cls: 0.01, fcp: 900 });

test('a single run is returned unchanged', () => {
  const only = score(90, 2000, 100);
  assert.equal(medianScores([only]), only);
});

// The point of the median: one wild run must not move the reported value.
test('an outlier run does not move the median', () => {
  const result = medianScores([score(90, 2000, 100), score(91, 2100, 120), score(40, 9000, 3000)]);
  assert.equal(result.performance, 90);
  assert.equal(result.lcp, 2100);
  assert.equal(result.tbt, 120);
});

test('an even number of runs averages the two middle values', () => {
  const result = medianScores([score(90, 2000, 100), score(94, 2400, 140)]);
  assert.equal(result.performance, 92);
  assert.equal(result.lcp, 2200);
  assert.equal(result.tbt, 120);
});

test('null runs are ignored, and an all-null set yields null', () => {
  const result = medianScores([null, score(80, 3000, 200), null]);
  assert.equal(result.performance, 80);
  assert.equal(medianScores([null, null]), null);
  assert.equal(medianScores([]), null);
});

test('non-numeric fields are skipped rather than corrupting the median', () => {
  const result = medianScores([
    { performance: 90, note: 'a' },
    { performance: 92, note: 'b' },
    { performance: 94, note: 'c' },
  ]);
  assert.equal(result.performance, 92);
  assert.equal(result.note, undefined);
});
