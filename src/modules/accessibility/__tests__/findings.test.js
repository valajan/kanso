import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, compare, extractFindings, MAX_NODES, sortFindings } from '../findings.js';

// The shape Lighthouse returns for an axe rule: a score of 0 with the failing
// elements in details.items, and the rule's impact in details.debugData.
function lhr(rules) {
  return {
    categories: { accessibility: { auditRefs: Object.keys(rules).map((id) => ({ id })) } },
    audits: Object.fromEntries(Object.entries(rules).map(([id, rule]) => [id, {
      score: 'score' in rule ? rule.score : 0,
      title: rule.title ?? `${id} is broken`,
      details: {
        items: (rule.selectors ?? []).map((selector) => ({ node: { selector, snippet: `<p class="${selector}">` } })),
        ...(rule.impact ? { debugData: { type: 'debugdata', impact: rule.impact } } : {}),
      },
    }])),
  };
}

test('extract keeps the rules the page failed, with their impact and elements', () => {
  const findings = extractFindings(lhr({
    'color-contrast': { impact: 'serious', selectors: ['p.intro', 'a.cta'] },
    'image-alt': { impact: 'critical', selectors: ['img.logo'] },
    'html-has-lang': { score: 1, selectors: [] },
    'video-caption': { score: null, selectors: [] },
  }));

  assert.deepEqual(findings.map((f) => f.rule), ['color-contrast', 'image-alt']);
  assert.equal(findings[0].impact, 'serious');
  assert.equal(findings[0].count, 2);
  assert.deepEqual(findings[0].nodes.map((n) => n.selector), ['p.intro', 'a.cta']);
});

// A rule with no impact reported is still a violation; it is judged as
// `serious` rather than slipping under the default threshold.
test('extract survives a rule Lighthouse reported without an impact', () => {
  const [finding] = extractFindings(lhr({ 'aria-valid-attr': { selectors: ['div#app'] } }));
  assert.equal(finding.impact, null);
});

test('extract keeps the whole element count but not every element', () => {
  const selectors = Array.from({ length: MAX_NODES + 20 }, (_, i) => `p:nth-child(${i})`);
  const [finding] = extractFindings(lhr({ 'color-contrast': { impact: 'serious', selectors } }));

  assert.equal(finding.count, MAX_NODES + 20);
  assert.equal(finding.nodes.length, MAX_NODES);
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

test('sortFindings puts what fails first, heaviest impact down', () => {
  const sorted = sortFindings([
    { rule: 'label', impact: 'critical', level: 'pass' },
    { rule: 'image-alt', impact: 'moderate', level: 'warn' },
    { rule: 'color-contrast', impact: 'serious', level: 'fail' },
    { rule: 'aria-roles', impact: 'critical', level: 'fail' },
  ]);

  assert.deepEqual(sorted.map((f) => f.rule), ['aria-roles', 'color-contrast', 'image-alt', 'label']);
});
