import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianScores } from '../median.js';

test('a single run is returned unchanged', () => {
  const only = { inp: 120 };
  assert.equal(medianScores([only]), only);
});

// The point of the median: one wild run must not move the reported value.
test('an outlier run does not move the median', () => {
  assert.equal(medianScores([{ inp: 120 }, { inp: 136 }, { inp: 900 }]).inp, 136);
});

test('an even number of runs averages the two middle values', () => {
  assert.equal(medianScores([{ inp: 120 }, { inp: 140 }]).inp, 130);
});

test('null runs are ignored, and an all-null set yields null', () => {
  assert.equal(medianScores([null, { inp: 80 }, null]).inp, 80);
  assert.equal(medianScores([null, null]), null);
  assert.equal(medianScores([]), null);
});

test('non-numeric fields are skipped rather than corrupting the median', () => {
  const result = medianScores([
    { inp: 90, note: 'a' },
    { inp: 92, note: 'b' },
    { inp: 94, note: 'c' },
  ]);
  assert.equal(result.inp, 92);
  assert.equal(result.note, undefined);
});
