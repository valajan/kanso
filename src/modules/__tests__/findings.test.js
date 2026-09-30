import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregate, compare, countLabel, elementHint, elementWhere, evaluateFindings, explanationLine, sortFindings,
} from '../findings.js';

const CONTRAST = 'Fix any of the following:\n  Element has insufficient color contrast of 4.27 (foreground color: #7a8088, background color: #1c1c1e, font size: 7.5pt (10px), font weight: normal). Expected contrast ratio of 4.5:1';

// A probe's finding of `color-contrast` on elements that share a selector,
// each with its own text and DOM path.
function contrast(count) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    selector: 'span.label', snippet: '<span class="label">', label: `text ${i}`, explanation: '', path: `1,HTML,1,BODY,${i},SPAN`,
  }));
  return [{ rule: 'color-contrast', title: 't', impact: 'serious', count, nodes }];
}

// Selectors are shortened, so ten spans in ten cards share one. Keyed on
// the selector, a page's 51 contrast failures once came out as 19.
test('aggregate keeps every element, however many share a selector', () => {
  const [finding] = aggregate({ mobile: contrast(3), desktop: null });

  assert.deepEqual(finding.nodes.map((n) => n.label), ['text 0', 'text 1', 'text 2']);
});

// The same element on both form factors is listed once, and the DOM path that
// said so is not reported: it names nothing a reader can search for.
test('aggregate lists an element failing on both form factors once', () => {
  const [finding] = aggregate({ mobile: contrast(2), desktop: contrast(3) });

  assert.deepEqual(finding.nodes.map((n) => n.label), ['text 0', 'text 1', 'text 2']);
  assert.ok(finding.nodes.every((n) => !('path' in n)));
});

test('aggregate folds the same rule seen on both form factors into one finding', () => {
  const findings = aggregate({
    mobile: [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 3, nodes: [{ selector: 'p.a' }, { selector: 'p.b' }] }],
    desktop: [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 2, nodes: [{ selector: 'p.a' }, { selector: 'p.c' }] }],
  });

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].formFactors, ['mobile', 'desktop']);
  assert.equal(findings[0].count, 3, 'the same page measured twice, not twice the problem');
  assert.deepEqual(findings[0].nodes.map((n) => n.selector), ['p.a', 'p.b', 'p.c']);
});

test('aggregate keeps a rule that only broke on one form factor', () => {
  const findings = aggregate({
    mobile: [{ rule: 'target-size', title: 't', impact: 'serious', count: 1, nodes: [] }],
    desktop: [],
  });

  assert.deepEqual(findings[0].formFactors, ['mobile']);
});

test('aggregate ignores a form factor whose load produced nothing', () => {
  const findings = aggregate({ mobile: [{ rule: 'image-alt', title: 't', impact: 'critical', count: 1, nodes: [] }], desktop: null });
  assert.equal(findings.length, 1);
});

// --- what axe could not settle ------------------------------------------------

// A rule is broken or it is not — except when axe says it cannot tell. Then
// what it reports is a doubt, and everything downstream has to keep knowing
// that, or a page nobody could check reads as a page that passed.
test('a rule that needs review on both form factors still needs review', () => {
  const doubt = (formFactor) => [{ rule: 'color-contrast', title: 't', impact: 'moderate', count: 1, nodes: [{ selector: `p.${formFactor}` }], needsReview: true }];
  const [finding] = aggregate({ mobile: doubt('mobile'), desktop: doubt('desktop') });

  assert.equal(finding.needsReview, true);
  assert.equal(finding.impact, 'moderate');
});

// The screen that could decide settles it: a contrast axe could not compute on
// a phone, and found wrong on a desktop, is wrong.
test('a rule broken on one form factor and merely doubted on the other is broken', () => {
  const [finding] = aggregate({
    mobile: [{ rule: 'color-contrast', title: 'could not be determined', impact: 'moderate', count: 1, nodes: [], needsReview: true }],
    desktop: [{ rule: 'color-contrast', title: 'contrast is too low', impact: 'serious', count: 2, nodes: [] }],
  });

  assert.equal(finding.needsReview, undefined);
  assert.equal(finding.impact, 'serious', 'an impact nobody gave must not win over one somebody did');
  assert.equal(finding.title, 'contrast is too low');
});

// A count of elements that fail and a count of elements nobody could decide on
// are not two measures of one thing, and subtracting them would say nothing.
test('compare judges a doubt as it stands rather than against a certainty', () => {
  const current = [{ rule: 'color-contrast', title: 't', impact: 'moderate', count: 1, nodes: [], needsReview: true }];
  const baseline = [{ rule: 'color-contrast', title: 't', impact: 'serious', count: 4, nodes: [] }];

  const { findings } = compare(current, baseline);
  assert.equal(findings[0].state, null);
  assert.equal(findings[0].baselineCount, null);

  // And the same the other way round.
  const back = compare(baseline, current).findings;
  assert.equal(back[0].state, null);
});

test('compare still weighs a doubt against the same doubt', () => {
  const doubt = (count) => [{ rule: 'color-contrast', title: 't', impact: 'moderate', count, nodes: [], needsReview: true }];

  assert.equal(compare(doubt(2), doubt(2)).findings[0].state, 'inherited');
  assert.equal(compare(doubt(3), doubt(2)).findings[0].state, 'worse');
});

test('compare tells a new rule from one that grew from one already there', () => {
  const current = [
    { rule: 'image-alt', count: 1, nodes: [] },
    { rule: 'color-contrast', count: 5, nodes: [] },
    { rule: 'label', count: 2, nodes: [] },
  ];
  const baseline = [
    { rule: 'color-contrast', count: 3, nodes: [] },
    { rule: 'label', count: 2, nodes: [] },
    { rule: 'link-name', count: 4, nodes: [] },
  ];

  const { findings, fixed } = compare(current, baseline);

  assert.deepEqual(findings.map((f) => [f.rule, f.state]), [
    ['image-alt', 'new'],
    ['color-contrast', 'worse'],
    ['label', 'inherited'],
  ]);
  assert.deepEqual(fixed.map((f) => f.rule), ['link-name']);
});

// Selectors move when the page does; counts do not. A finding whose elements
// were renamed but not multiplied is the same finding.
test('compare does not call a finding new because its selectors moved', () => {
  const current = [{ rule: 'color-contrast', count: 2, nodes: [{ selector: 'div:nth-child(4) > p' }] }];
  const baseline = [{ rule: 'color-contrast', count: 2, nodes: [{ selector: 'div:nth-child(3) > p' }] }];

  const { findings } = compare(current, baseline);
  assert.equal(findings[0].state, 'inherited');
});

test('compare without a baseline leaves every state unset', () => {
  const { findings, fixed } = compare([{ rule: 'image-alt', count: 1, nodes: [] }], null);
  assert.equal(findings[0].state, null);
  assert.deepEqual(fixed, []);
});

test('an explanation reads on one line, without axe\'s preamble', () => {
  assert.equal(
    explanationLine(CONTRAST),
    'Element has insufficient color contrast of 4.27 (foreground color: #7a8088, background color: #1c1c1e, font size: 7.5pt (10px), font weight: normal). Expected contrast ratio of 4.5:1',
  );
  assert.equal(
    explanationLine('Fix all of the following:\n  Element is focusable\n\nFix any of the following:\n  Element has no alt\n  Element has no title'),
    'Element is focusable; Element has no alt; Element has no title',
  );
  assert.equal(explanationLine(''), '');
  assert.equal(explanationLine(undefined), '');
});

// Ten elements can share a selector; their text tells them apart, and an image,
// which has none, is told apart by its tag.
test('an element is told apart by its text, or by its tag when it has no text', () => {
  assert.deepEqual(elementHint({ selector: 'td', label: 'Metric\tmain\nLCP\t1.2s', snippet: '<td>' }), { text: 'Metric main LCP 1.2s' });
  assert.deepEqual(elementHint({ selector: 'body > img', label: 'body > img', snippet: '<img src="/hero.png">' }), { tag: '<img src="/hero.png">' });
  assert.equal(elementHint({ selector: 'html', label: 'html', snippet: '<html>' }), null, 'a bare tag says nothing the selector did not');
  assert.equal(elementHint({ selector: '', snippet: '<img src="/a.png">' }), null, 'a tag already standing in for the selector');
});

test('sortFindings puts what fails first, heaviest impact down', () => {
  const sorted = sortFindings([
    { rule: 'label', impact: 'critical', level: 'pass' },
    { rule: 'image-alt', impact: 'moderate', level: 'warn' },
    { rule: 'color-contrast', impact: 'serious', level: 'fail' },
    { rule: 'aria-roles', impact: 'critical', level: 'fail' },
  ]);

  assert.deepEqual(sorted.map((f) => f.rule), ['aria-roles', 'color-contrast', 'image-alt', 'label']);
});

// Keyed on an empty selector, every error of the second form factor would read
// as one already seen.
test('aggregate tells apart failures that are no DOM element by what is said of them', () => {
  const error = (description) => ({ selector: '', snippet: '', label: '', explanation: description, path: '', url: 'http://localhost:4173/app.js:1:0' });
  const [finding] = aggregate({
    mobile: [{ rule: 'close-error', title: 't', impact: 'moderate', count: 1, nodes: [error('boom')] }],
    desktop: [{ rule: 'close-error', title: 't', impact: 'moderate', count: 2, nodes: [error('boom'), error('bang')] }],
  });

  assert.deepEqual(finding.nodes.map((n) => n.explanation), ['boom', 'bang']);
});

// A form factor's worth of findings, for evaluateFindings.
const loads = (current, baseline = null) => ({
  formFactors: { mobile: { current: { findings: current }, baseline: baseline && { findings: baseline } }, desktop: { current: null, baseline: null } },
  baselineAudited: baseline != null,
});
const finding = (rule, impact, count = 1) => ({ rule, title: rule, impact, count, nodes: [] });

test('an ignored rule is neither reported nor judged, on either page, and the report says it was ignored', () => {
  const result = evaluateFindings(
    loads([finding('region', 'critical'), finding('heading-order', 'moderate')], [finding('landmark-one-main', 'serious')]),
    { ignore: ['region', 'landmark-one-main'] },
  );

  assert.deepEqual(result.levels, { 'heading-order': 'warn' });
  assert.deepEqual(result.fixed, [], 'an ignored rule is not "fixed" either');
  assert.deepEqual(result.ignore, ['region', 'landmark-one-main']);
});

test('ignore takes one rule or a list, and nothing else', () => {
  const page = loads([finding('region', 'critical')]);
  assert.deepEqual(evaluateFindings(page, { ignore: 'region' }).levels, {});
  assert.deepEqual(evaluateFindings(page, { ignore: { rule: 'region' } }).ignore, []);
  assert.deepEqual(evaluateFindings(page, {}).ignore, []);
});

test('a finding is counted in elements when they are all in the DOM, in items otherwise, and not at all when none was listed', () => {
  assert.equal(countLabel({ count: 51, nodes: [{ selector: 'p' }] }), '51 elements');
  assert.equal(countLabel({ count: 1, nodes: [{ selector: '', url: 'http://localhost:4173/favicon.ico' }] }), '1 item');
  assert.equal(countLabel({ count: 0, nodes: [] }), '');
});

test('an element is placed by its selector, else its tag, else the URL it names', () => {
  assert.equal(elementWhere({ selector: 'body > img', snippet: '<img>', url: 'http://a/b.png' }), 'body > img');
  assert.equal(elementWhere({ selector: '', snippet: '<meta name="robots">', url: '' }), '<meta name="robots">');
  assert.equal(elementWhere({ selector: '', snippet: '', url: 'http://a/app.js:3:1' }), 'http://a/app.js:3:1');
});

// --- the declared states of a page ------------------------------------------------

// A rule broken in the menu is not the same finding as that rule broken on the
// page as it loads: two places to go and fix, each compared and judged on its
// own. And a project that declares no state sees exactly what it saw before.
const at = (state, rule, impact, count = 1) => ({ ...finding(rule, impact, count), at: state });

test('a rule broken in two states is two findings, and its level says where', () => {
  const result = evaluateFindings(loads([finding('color-contrast', 'serious'), at('menu', 'color-contrast', 'serious', 3)]));

  assert.deepEqual(result.findings.map(({ rule, at: where, count }) => [rule, where, count]), [
    ['color-contrast', undefined, 1],
    ['color-contrast', 'menu', 3],
  ]);
  assert.deepEqual(result.levels, { 'color-contrast': 'fail', 'color-contrast@menu': 'fail' });
});

test('aggregate folds a rule state by state, across form factors', () => {
  const folded = aggregate({
    mobile: [at('menu', 'button-name', 'critical'), finding('button-name', 'critical')],
    desktop: [at('menu', 'button-name', 'critical', 2)],
  });

  assert.deepEqual(folded.map(({ rule, at: where, count, formFactors }) => [rule, where, count, formFactors]), [
    ['button-name', 'menu', 2, ['mobile', 'desktop']],
    ['button-name', undefined, 1, ['mobile']],
  ]);
});

test('a state is compared with the same state of the baseline, never with its page as it loads', () => {
  const { findings, fixed } = compare(
    [finding('color-contrast', 'serious', 2), at('menu', 'color-contrast', 'serious', 2)],
    [finding('color-contrast', 'serious', 2), at('signup', 'label', 'critical')],
  );

  assert.deepEqual(findings.map(({ at: where, state }) => [where, state]), [[undefined, 'inherited'], ['menu', 'new']]);
  assert.deepEqual(fixed, [{ rule: 'label', at: 'signup', title: 'label', impact: 'critical', count: 1 }]);
});

// The change renamed the button that opens the menu: the page under audit
// reaches the menu, the baseline cannot. What is found there has nothing to be
// compared with, and is judged as it stands — not called new.
test('a state the baseline could not reach leaves what is found there unjudged against it', () => {
  const unreached = { probe: 'axe', rules: ['color-contrast', 'label'], error: 'nothing visible to click at #open', at: 'menu' };
  const result = evaluateFindings({
    formFactors: {
      mobile: {
        current: { findings: [finding('color-contrast', 'serious'), at('menu', 'color-contrast', 'serious')] },
        baseline: { findings: [], probeFailures: [unreached] },
      },
      desktop: { current: null, baseline: null },
    },
    baselineAudited: true,
  });

  assert.deepEqual(result.findings.map(({ at: where, state }) => [where ?? null, state]), [[null, 'new'], ['menu', null]]);
  assert.deepEqual(result.probeFailures, [{ ...unreached, side: 'baseline', formFactor: 'mobile' }]);
});

test('what the baseline broke in a state the page under audit could not reach is not fixed', () => {
  const result = evaluateFindings({
    formFactors: {
      mobile: {
        current: { findings: [], probeFailures: [{ probe: 'axe', rules: ['label'], error: 'timed out after 30s', at: 'signup' }] },
        baseline: { findings: [at('signup', 'label', 'critical'), finding('image-alt', 'critical')] },
      },
      desktop: { current: null, baseline: null },
    },
    baselineAudited: true,
  });

  assert.deepEqual(result.fixed.map(({ rule, at: where }) => [rule, where]), [['image-alt', undefined]]);
});

test('an ignored rule is ignored in every state', () => {
  const result = evaluateFindings(loads([finding('region', 'moderate'), at('menu', 'region', 'moderate'), at('menu', 'label', 'critical')]), { ignore: ['region'] });
  assert.deepEqual(result.levels, { 'label@menu': 'fail' });
});
