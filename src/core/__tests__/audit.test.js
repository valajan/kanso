import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audit, SCREENSHOT } from '../audit.js';
import performance from '../../modules/performance/index.js';

const GOOD = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
const ALL_BUDGETS = { performance: 90, lcp: 2500, tbt: 200, cls: 0.1, fcp: 1800, inp: 200 };

// Answers each load with what the requested modules would have extracted, and
// records the load so tests can assert on what was fetched.
function fakeRunner(byUrl) {
  const calls = [];
  const run = async (url, { formFactor, runs, modules, config }) => {
    calls.push({ url, formFactor, runs, modules: modules.map((m) => m.id), config });
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

// The probes run inside the worker, where nothing else of the configuration
// reaches: what they check — the rules of a rule set, the states to walk — is
// a matter of configuration like everything else, so the whole resolved file
// travels with the load and each probe is handed its own module's section.
test('the resolved configuration travels with every load, for the probes to read', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': { performance: GOOD } });
  const config = { runs: 1, accessibility: { tags: ['wcag2a'] } };

  await audit({ url: 'http://localhost:3000/', config, runLighthouse, modules: [performance] });

  assert.ok(runLighthouse.calls.length > 0);
  for (const call of runLighthouse.calls) assert.deepEqual(call.config, config);
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
  assert.deepEqual(perf.budgets, { performance: 101, lcp: 4000, tbt: 600, cls: 0.25, fcp: 3000, inp: 500 });
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

// A probe that needs a state to open does not run when the project declares
// none. The core says so from the configuration alone — the same reading the
// worker makes to leave it out — module by module, less the rules `ignore:`
// leaves out: a rule nobody checked must not read as one that passed.
test('the probes left out for want of a state are listed on their module, with the rules they would have checked', async () => {
  const inp = { id: 'inp', rules: ['inp'], onlyInStates: true };
  const axe = { id: 'axe', rules: ['image-alt'], states: true };
  const focus = { id: 'focus', rules: ['focus-lost', 'focus-not-returned'], transitions: true };
  const clicks = { ...links, id: 'clicks', probes: [inp] };
  const keys = { ...links, id: 'keys', probes: [axe, focus] };
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': {} });
  const run = (config) => audit({ url: 'http://localhost:3000/', config, runLighthouse, modules: [clicks, keys, links] });

  const bare = await run({});
  assert.deepEqual(bare.modules.clicks.skipped, [{ probe: 'inp', rules: ['inp'], reason: 'no-states' }]);
  assert.deepEqual(bare.modules.links.skipped, [], 'a module with no such probe skips nothing');
  assert.deepEqual(bare.modules.keys.skipped, [{ probe: 'focus', rules: ['focus-lost', 'focus-not-returned'], reason: 'no-states' }], 'a probe that also reads the page as it loads runs');

  const ignoring = await run({ keys: { ignore: ['focus-lost'] } });
  assert.deepEqual(ignoring.modules.keys.skipped.map(({ rules }) => rules), [['focus-not-returned']]);
  const ignoringAll = await run({ keys: { ignore: ['focus-lost', 'focus-not-returned'] } });
  assert.deepEqual(ignoringAll.modules.keys.skipped, []);

  // A state one screen has is a state declared: the other screen has none to
  // open, and nothing is missing there.
  const declared = await run({ states: [{ name: 'menu', click: '#open', form_factor: 'desktop' }] });
  assert.deepEqual(declared.modules.keys.skipped, []);
  assert.deepEqual(declared.modules.clicks.skipped, []);
});
