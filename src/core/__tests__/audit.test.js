import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, SCREENSHOT } from '../audit.js';
import performance from '../../modules/performance/index.js';

const GOOD = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
const ALL_BUDGETS = { performance: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800 };

// Answers each load with what the requested modules would have extracted, and
// records the load so tests can assert on what was fetched.
function fakeRunner(byUrl) {
  const calls = [];
  const run = async (url, { formFactor, runs, modules }) => {
    calls.push({ url, formFactor, runs, modules: modules.map((m) => m.id) });
    const result = byUrl[url];
    if (typeof result === 'function') return result(formFactor);
    if (result === undefined) throw new Error(`unexpected audit target ${url}`);
    return Object.fromEntries(modules.map((m) => [m.id, result[m.id]]));
  };
  run.calls = calls;
  return run;
}

// A deterministic module, standing in for accessibility or SEO: it judges
// findings rather than measures, and never needs a baseline.
const links = {
  id: 'links',
  label: 'Links',
  categories: [],
  extract: () => null,
  combine: (samples) => samples[0],
  needsBaseline: () => false,
  evaluate: ({ formFactors }) => ({
    levels: { 'broken-links': formFactors.mobile.current?.broken > 0 ? 'fail' : 'pass' },
  }),
};

test('audits a page against a baseline, with no forge or PR involved', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:3000/': { performance: GOOD },
    'http://localhost:4000/': { performance: GOOD },
  });

  const result = await audit({
    url: 'http://localhost:3000/',
    baseline: 'http://localhost:4000/',
    runLighthouse,
  });

  assert.equal(result.ok, true);
  assert.equal(result.conclusion, 'pass');
  assert.deepEqual(result.failures, []);
  assert.equal(result.modules.performance.referenceKind, 'baseline');
  assert.deepEqual(result.modules.performance.scores.mobile, { current: GOOD, reference: GOOD });
  assert.equal(runLighthouse.calls.length, 4);
});

// A baseline gives Δ its meaning, never the verdict: the budgets the levels were
// read against come back with them, compared or not — including the metrics
// the config left to Lighthouse's "poor" boundary.
test('the budgets a verdict was read against come back with it, baseline or not', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:3000/': { performance: GOOD },
    'http://localhost:4000/': { performance: GOOD },
  });

  const result = await audit({
    url: 'http://localhost:3000/',
    baseline: 'http://localhost:4000/',
    config: { budgets: { performance: 101 } },
    modules: [performance],
    runLighthouse,
  });

  const perf = result.modules.performance;
  assert.equal(perf.referenceKind, 'baseline');
  assert.equal(perf.levels.performance, 'fail', 'equal to the baseline, and still under the budget');
  assert.deepEqual(perf.budgets, { performance: 101, lcp: 4000, tbt: 600, cls: 0.25, fcp: 3000 });
});

test('a module that can judge from its config alone skips the baseline load', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': { performance: GOOD } });

  const result = await audit({
    url: 'http://localhost:3000/',
    baseline: 'http://localhost:4000/',
    config: { budgets: ALL_BUDGETS },
    modules: [performance],
    runLighthouse,
  });

  assert.equal(result.modules.performance.referenceKind, 'budgets');
  assert.ok(runLighthouse.calls.every((c) => c.url === 'http://localhost:3000/'));
});

// A baseline named in the config is a hint the core may ignore; one the caller
// asked for is an instruction, and the comparison column is the point of it.
// One page load feeds every module — the worker asks Lighthouse for the union
// of their categories and hands each the same report. A second concern
// therefore costs a category, not a load, which is the whole bet of the module
// interface.
test('a second module costs no extra page load', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': { performance: GOOD, links: { broken: 0 } } });

  const alone = await audit({ url: 'http://localhost:3000/', runLighthouse, modules: [performance] });
  const loadsAlone = runLighthouse.calls.length;
  const together = await audit({ url: 'http://localhost:3000/', runLighthouse, modules: [performance, links] });

  assert.equal(alone.ok, true);
  assert.equal(together.ok, true);
  assert.equal(runLighthouse.calls.length - loadsAlone, loadsAlone);
  assert.deepEqual(runLighthouse.calls.at(-1).modules, ['performance', 'links']);
});

test('alwaysCompare loads the baseline even when no module needs it', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:3000/': { performance: GOOD },
    'http://localhost:4000/': { performance: GOOD },
  });

  const result = await audit({
    url: 'http://localhost:3000/',
    baseline: 'http://localhost:4000/',
    config: { budgets: ALL_BUDGETS },
    alwaysCompare: true,
    runLighthouse,
  });

  assert.equal(result.modules.performance.referenceKind, 'baseline');
  assert.equal(runLighthouse.calls.length, 4);
});

test('the conclusion is the worst across modules, and each module keeps its own', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:3000/': { performance: GOOD, links: { broken: 2 } },
    'http://localhost:4000/': { performance: GOOD },
  });

  const result = await audit({
    url: 'http://localhost:3000/',
    baseline: 'http://localhost:4000/',
    runLighthouse,
    modules: [performance, links],
  });

  assert.equal(result.conclusion, 'fail');
  assert.equal(result.modules.performance.conclusion, 'pass');
  assert.deepEqual(result.modules.links.levels, { 'broken-links': 'fail' });
  // The baseline is only loaded for the modules that compare against it.
  const baselineLoads = runLighthouse.calls.filter((c) => c.url === 'http://localhost:4000/');
  assert.ok(baselineLoads.every((c) => c.modules.join() === 'performance'));
});

test('a failed load is reported without failing the audit, unless every form factor failed', async () => {
  const partial = await audit({
    url: 'http://localhost:3000/',
    runLighthouse: fakeRunner({
      'http://localhost:3000/': (formFactor) => {
        if (formFactor === 'desktop') throw new Error('desktop died');
        return { performance: GOOD };
      },
    }),
  });

  assert.equal(partial.ok, true);
  assert.deepEqual(partial.failures.map((f) => `${f.side}|${f.formFactor}|${f.error}`), ['current|desktop|desktop died']);
  assert.equal(partial.modules.performance.scores.desktop.current, null);

  const total = await audit({
    url: 'http://localhost:3000/',
    runLighthouse: async () => { throw new Error('chrome crashed'); },
  });

  assert.equal(total.ok, false);
  assert.equal(total.conclusion, 'error');
  assert.equal(total.error, 'chrome crashed');
});

// --- screenshots ----------------------------------------------------------------

test('screenshots are asked of the page under audit only, and returned per form factor', async () => {
  const calls = [];
  const runLighthouse = async (url, { formFactor, modules, screenshot }) => {
    calls.push([url, formFactor, screenshot ?? false]);
    const data = Object.fromEntries(modules.map((m) => [m.id, GOOD]));
    if (screenshot && formFactor === 'mobile') data[SCREENSHOT] = 'data:image/jpeg;base64,AAAA';
    return data;
  };

  const result = await audit({
    url: 'http://localhost:3000/', baseline: 'http://localhost:4000/', runLighthouse,
    modules: [performance], alwaysCompare: true, screenshots: true,
  });

  assert.deepEqual(result.screenshots, { mobile: 'data:image/jpeg;base64,AAAA', desktop: null });
  assert.deepEqual(calls.filter(([, , shot]) => shot).map(([url]) => url), ['http://localhost:3000/', 'http://localhost:3000/']);

  const without = await audit({ url: 'http://localhost:3000/', runLighthouse, modules: [performance] });
  assert.equal('screenshots' in without, false, 'nobody asked');
});
