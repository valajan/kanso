import { test } from 'node:test';
import assert from 'node:assert/strict';
import accessibility from '../index.js';

// One form factor's worth of extracted findings.
function sample(...findings) {
  return { findings: findings.map((f) => ({ nodes: [], count: 1, title: `${f.rule} is broken`, ...f })) };
}

function evaluate({ mobile, desktop = mobile, baseline = null, baselineAudited = baseline != null, config = {} }) {
  return accessibility.evaluate({
    formFactors: {
      mobile: { current: mobile, baseline },
      desktop: { current: desktop, baseline },
    },
    baselineAudited,
  }, config);
}

test('without a baseline, every finding is judged on its impact', () => {
  const result = evaluate({
    mobile: sample(
      { rule: 'image-alt', impact: 'critical' },
      { rule: 'color-contrast', impact: 'serious' },
      { rule: 'heading-order', impact: 'moderate' },
    ),
  });

  assert.deepEqual(result.levels, { 'image-alt': 'fail', 'color-contrast': 'fail', 'heading-order': 'warn' });
  assert.equal(result.comparedToBaseline, false);
  assert.equal(result.failOn, 'serious');
  assert.deepEqual(result.findings.map((f) => f.state), [null, null, null]);
});

test('fail_on moves the line between a failure and a warning', () => {
  const findings = sample({ rule: 'color-contrast', impact: 'serious' });

  assert.equal(evaluate({ mobile: findings, config: { fail_on: 'critical' } }).levels['color-contrast'], 'warn');
  assert.equal(evaluate({ mobile: findings, config: { fail_on: 'minor' } }).levels['color-contrast'], 'fail');
});

// A typo in a config file must not sink an audit.
test('an unreadable fail_on falls back to the default, and says so', () => {
  const result = evaluate({ mobile: sample({ rule: 'image-alt', impact: 'critical' }), config: { fail_on: 'sevre' } });
  assert.equal(result.failOn, 'serious');
});

// The point of loading a second page: what the change did, told apart from what
// it inherited.
test('a finding the baseline already has is reported but not held against the change', () => {
  const result = evaluate({
    mobile: sample(
      { rule: 'color-contrast', impact: 'serious', count: 4 },
      { rule: 'image-alt', impact: 'critical', count: 1 },
    ),
    baseline: sample(
      { rule: 'color-contrast', impact: 'serious', count: 4 },
      { rule: 'link-name', impact: 'serious', count: 2 },
    ),
  });

  assert.deepEqual(result.levels, { 'image-alt': 'fail', 'color-contrast': 'pass' });
  assert.equal(result.comparedToBaseline, true);
  assert.deepEqual(result.fixed.map((f) => f.rule), ['link-name']);
});

test('a rule the change broke on more elements counts as a regression', () => {
  const result = evaluate({
    mobile: sample({ rule: 'color-contrast', impact: 'serious', count: 6 }),
    baseline: sample({ rule: 'color-contrast', impact: 'serious', count: 4 }),
  });

  assert.equal(result.levels['color-contrast'], 'fail');
  assert.equal(result.findings[0].state, 'worse');
  assert.equal(result.findings[0].baselineCount, 4);
});

// Reading every inherited violation as new would fail a change that touched
// none of them.
test('a baseline that was scheduled but never loaded is not compared against', () => {
  const result = evaluate({
    mobile: sample({ rule: 'color-contrast', impact: 'serious' }),
    baseline: null,
    baselineAudited: true,
  });

  assert.equal(result.comparedToBaseline, false);
  assert.equal(result.findings[0].state, null);
  assert.equal(result.levels['color-contrast'], 'fail');
});

test('a page that breaks no rule passes with an empty list', () => {
  const result = evaluate({ mobile: sample() });
  assert.deepEqual(result.levels, {});
  assert.deepEqual(result.findings, []);
});

// Empty means "measured, nothing found"; null means "nothing was measured".
test('no result at all is not the same as no findings', () => {
  const result = evaluate({ mobile: null, desktop: null });
  assert.equal(result.findings, null);
  assert.deepEqual(result.levels, {});
});

test('repeated loads are not folded — the first sample is the answer', () => {
  const first = sample({ rule: 'image-alt', impact: 'critical' });
  assert.equal(accessibility.combine([first, sample()]), first);
  assert.equal(accessibility.combine([null, first]), first);
  assert.equal(accessibility.combine([null, null]), null);
});

test('the module always wants the baseline, whatever the config says', () => {
  assert.equal(accessibility.needsBaseline({ fail_on: 'critical' }), true);
});

// What makes this module its own: the impact of a rule is the one axe gave it.
test('a rule is ranked by the impact axe gave it', () => {
  const { findings } = accessibility.extract({
    categories: { accessibility: { auditRefs: [{ id: 'color-contrast' }, { id: 'aria-valid-attr' }] } },
    audits: {
      'color-contrast': { score: 0, title: 't', details: { items: [], debugData: { type: 'debugdata', impact: 'serious' } } },
      'aria-valid-attr': { score: 0, title: 't', details: { items: [] } },
    },
  });

  assert.deepEqual(findings.map((f) => f.impact), ['serious', null]);
});

// --- what the probes add ------------------------------------------------------------

const REFLOW = { rule: 'reflow-scroll', impact: 'serious', nodes: [{ selector: 'div.wide', snippet: '<div class="wide">', label: '', explanation: '400px wide', path: '1,HTML,1,BODY,0,DIV' }] };
const REFLOW_FAILED = { probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'], error: 'timed out after 30s' };

test('the probes\' findings join axe\'s in the sample, and a load without probes has only axe\'s', () => {
  const report = { categories: { accessibility: { auditRefs: [] } }, audits: {} };

  const probed = accessibility.extract(report, { probed: { findings: [REFLOW], failures: [] } });
  assert.deepEqual(probed, { findings: [REFLOW] });

  const failed = accessibility.extract(report, { probed: { findings: [], failures: [REFLOW_FAILED] } });
  assert.deepEqual(failed, { findings: [], probeFailures: [REFLOW_FAILED] });

  assert.deepEqual(accessibility.extract(report, { probed: null }), { findings: [] });
  assert.deepEqual(accessibility.extract(report), { findings: [] });
});

test('a probe finding is judged like any other: new against a baseline without it, inherited against one with it', () => {
  const page = sample(REFLOW);

  assert.equal(evaluate({ mobile: page, desktop: sample(), baseline: sample() }).findings[0].state, 'new');
  assert.equal(evaluate({ mobile: page, desktop: sample(), baseline: sample(REFLOW) }).levels['reflow-scroll'], 'pass');
});

// A probe that did not run checked nothing, which is not finding nothing.
test('what a probe could not check on the baseline is judged as the page stands, and said', () => {
  const result = evaluate({
    mobile: sample(REFLOW),
    desktop: sample(),
    baseline: { ...sample(), probeFailures: [REFLOW_FAILED] },
  });

  assert.equal(result.findings[0].state, null, 'not "new": the baseline was never looked at');
  assert.equal(result.levels['reflow-scroll'], 'fail');
  assert.deepEqual(result.probeFailures.map(({ probe, side }) => [probe, side]), [['reflow', 'baseline'], ['reflow', 'baseline']]);
});

test('what a probe could not check on the page is never said fixed', () => {
  const result = evaluate({
    mobile: { ...sample(), probeFailures: [REFLOW_FAILED] },
    desktop: sample(),
    baseline: sample(REFLOW),
  });

  assert.deepEqual(result.fixed, []);
  assert.deepEqual(result.probeFailures, [{ ...REFLOW_FAILED, side: 'current', formFactor: 'mobile' }]);
});

test('a failed probe whose rules are all ignored is not worth reporting', () => {
  const result = evaluate({
    mobile: { ...sample(), probeFailures: [REFLOW_FAILED] },
    desktop: sample(),
    config: { ignore: ['reflow-scroll', 'reflow-clip'] },
  });
  assert.deepEqual(result.probeFailures, []);

  const partly = evaluate({ mobile: { ...sample(), probeFailures: [REFLOW_FAILED] }, desktop: sample(), config: { ignore: ['reflow-clip'] } });
  assert.deepEqual(partly.probeFailures[0].rules, ['reflow-scroll']);
});
