import { test } from 'node:test';
import assert from 'node:assert/strict';
import performance from '../index.js';
import { inpDiagnostics, slowestInteraction } from '../inp.js';
import { evaluateStatuses } from '../status.js';

// A Lighthouse report with every metric the module reads, and nothing else.
const LHR = {
  categories: { performance: { score: 0.9 } },
  audits: {
    'largest-contentful-paint': { numericValue: 2000 },
    'total-blocking-time': { numericValue: 100 },
    'cumulative-layout-shift': { numericValue: 0.01 },
    'first-contentful-paint': { numericValue: 900 },
  },
};

const click = (at, latency) => ({
  type: 'click', at, latency, inputDelay: 2, processing: latency - 10, presentation: 8,
  target: { selector: `button#${at}`, snippet: `<button id="${at}">`, label: at, path: '' },
});

test('the INP of a load is its slowest declared click', () => {
  const probed = { findings: [], failures: [], measures: [click('menu', 90), click('signup', 320), click('close', 40)] };
  const sample = performance.extract(LHR, { probed });

  assert.equal(sample.inp, 320);
  assert.deepEqual(sample.diagnostics.inp, { interaction: click('signup', 320), count: 3, failures: [] });
});

// No state declared: the probe never ran, and there is no number — not 0 ms,
// which would read as a page that answers at once.
test('a load nobody clicked has no INP, and no status for it', () => {
  const sample = performance.extract(LHR, { probed: null });

  assert.equal(sample.inp, null);
  assert.equal(sample.diagnostics.inp, null);
  assert.equal(evaluateStatuses({ performance: 90, lcp: 2000, tbt: 100, cls: 0.01, fcp: 900, inp: null }).inp, undefined);
});

test('a state not reached is kept with the INP of the ones that were', () => {
  const probed = {
    findings: [],
    measures: [click('menu', 90)],
    failures: [{ probe: 'inp', rules: ['inp'], at: 'signup', error: 'nothing visible to click at #signup' }],
  };
  const sample = performance.extract(LHR, { probed });

  assert.equal(sample.inp, 90);
  assert.deepEqual(sample.diagnostics.inp.failures, [{ at: 'signup', error: 'nothing visible to click at #signup' }]);
});

test('the INP is judged on its own thresholds, 200 and 500 ms', () => {
  const status = (inp) => evaluateStatuses({ inp }).inp;
  assert.equal(status(180), 'pass');
  assert.equal(status(320), 'warn');
  assert.equal(status(620), 'fail');
  assert.equal(evaluateStatuses({ inp: 320 }, { inp: 300 }).inp, 'fail', 'a budget of its own');
});

// Repeated loads fold like the other metrics: the median, and the slowest
// interaction of the load that produced it.
test('repeated loads fold the INP into its median', () => {
  const load = (latency) => performance.extract(LHR, { probed: { findings: [], failures: [], measures: [click('menu', latency)] } });
  const combined = performance.combine([load(300), load(120), load(210)]);

  assert.equal(combined.inp, 210);
  assert.equal(combined.diagnostics.inp.interaction.latency, 210);
});

test('the helpers read nothing into nothing', () => {
  assert.equal(slowestInteraction([]), null);
  assert.equal(slowestInteraction(undefined), null);
  assert.equal(inpDiagnostics(null), null);
});
