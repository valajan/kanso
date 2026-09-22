import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axeFindings, ruleIds, tagsOf } from '../axe.js';

// The translation of what axe reports into what Kanso reports. What axe makes
// of a page runs in Chrome: see test/probes/ for that side, against a real
// browser.
const node = (selector) => ({ selector, snippet: `<p class="${selector}">`, label: 'text', path: '1,HTML,1,BODY,0,P', explanation: 'Fix any of the following:\n  the contrast is 2.1:1' });
const rule = (id, extra = {}) => ({ id, help: `${id} help`, impact: 'serious', tags: ['wcag2aa', 'wcag143'], count: 1, nodes: [node('one')], ...extra });

test('a page breaking no rule has no findings', () => {
  assert.deepEqual(axeFindings({ violations: [], incomplete: [] }), []);
});

test('a broken rule becomes a finding, with axe’s own impact and every element it kept', () => {
  const [finding] = axeFindings({
    violations: [{
      id: 'color-contrast',
      help: 'Elements must meet minimum color contrast ratio thresholds',
      impact: 'serious',
      tags: ['cat.color', 'wcag2aa', 'wcag143'],
      count: 12,
      nodes: [node('faint'), node('fainter')],
    }],
    incomplete: [],
  });

  assert.deepEqual(finding, {
    rule: 'color-contrast',
    title: 'Elements must meet minimum color contrast ratio thresholds',
    impact: 'serious',
    // The count is what the page does, not what was kept of it.
    count: 12,
    nodes: [node('faint'), node('fainter')],
    detail: 'WCAG 1.4.3 (AA)',
  });
  assert.equal('needsReview' in finding, false);
});

// The `detail` line says what the rule answers to, so that nobody reads a law
// into a rule that is none, nor shrugs off one that is.
test('the criteria a rule covers are read off its tags, in order, at their level', () => {
  const detail = (tags) => axeFindings({ violations: [rule('r', { tags })] })[0].detail;

  assert.equal(detail(['cat.keyboard', 'wcag2a', 'wcag211']), 'WCAG 2.1.1 (A)');
  assert.equal(detail(['cat.structure', 'wcag21aa', 'wcag1410']), 'WCAG 1.4.10 (AA)');
  // 1.4.10 comes after 1.4.3, and the most demanding level is the one that binds.
  assert.equal(detail(['wcag2a', 'wcag21aa', 'wcag1410', 'wcag143']), 'WCAG 1.4.3, 1.4.10 (A)');
  assert.equal(detail(['wcag2aaa', 'wcag249']), 'WCAG 2.4.9 (AAA)');
  // A rule of axe's own, bound to no criterion, says so rather than nothing.
  assert.equal(detail(['cat.semantics', 'best-practice']), 'Best practice');
  assert.equal(detail(['cat.semantics']), undefined);
});

// An impact is what the verdict rests on; axe gives one to every rule it
// breaks, and a missing one is left null rather than invented.
test('a rule axe did not rank carries no impact', () => {
  assert.equal(axeFindings({ violations: [rule('r', { impact: undefined })] })[0].impact, null);
});

// --- what axe could not settle ------------------------------------------------

test('a rule axe could not settle is reported, marked, and capped at moderate', () => {
  const [finding] = axeFindings({
    violations: [],
    incomplete: [rule('color-contrast', { impact: 'serious', count: 3 })],
  });

  assert.equal(finding.rule, 'color-contrast');
  assert.equal(finding.needsReview, true);
  // Reported, but a doubt cannot fail an audit at the default threshold.
  assert.equal(finding.impact, 'moderate');
  assert.equal(finding.count, 3);
});

// A rule axe gave no impact to would otherwise be judged `serious`, which is
// exactly what a doubt must not be.
test('an unranked doubt is capped too, rather than read as serious', () => {
  const [finding] = axeFindings({ incomplete: [rule('r', { impact: null })] });
  assert.equal(finding.impact, 'moderate');
});

// Two findings of one rule would be folded into one by `aggregate`, and
// compared to the baseline as one: the certainty wins, and says it all.
test('a rule both broken and unsettled is reported broken, once', () => {
  const findings = axeFindings({
    violations: [rule('color-contrast', { count: 2 })],
    incomplete: [rule('color-contrast', { count: 7 })],
  });

  assert.deepEqual(findings.map((finding) => [finding.rule, finding.count, finding.needsReview]), [['color-contrast', 2, undefined]]);
});

// --- the rules the probe covers -----------------------------------------------

test('the default rule set is the WCAG A/AA and best-practice one', () => {
  const rules = ruleIds(tagsOf({}));

  assert.equal(rules.length, 100);
  assert.deepEqual(rules, [...rules].sort());
  // Three Lighthouse leaves out: an AA rule, a best-practice one, and the one
  // AAA rule axe can decide on its own.
  for (const id of ['role-img-alt', 'region', 'identical-links-same-purpose']) assert.ok(rules.includes(id), id);
  // And one axe knows that nobody asked for: contrast at the AAA threshold.
  assert.ok(!rules.includes('color-contrast-enhanced'));
});

test('a project narrows or widens the set with tags, and a typo narrows nothing', () => {
  // The WCAG 2.0 set alone: no `region`, which answers to no criterion.
  const strict = ruleIds(tagsOf({ tags: ['wcag2a', 'wcag2aa'] }));
  assert.ok(strict.length < 100);
  assert.ok(!strict.includes('region'));
  // One tag, written as one.
  assert.deepEqual(ruleIds(tagsOf({ tags: 'best-practice' })), ruleIds(['best-practice']));
  // A tag axe does not know would silently narrow the audit; the default set
  // stands instead — the same rule `fail_on:` follows.
  assert.deepEqual(tagsOf({ tags: ['wacg2a'] }), tagsOf({}));
  assert.deepEqual(tagsOf({ tags: ['wcag2a', 'wacg2a'] }), ['wcag2a']);
  assert.deepEqual(tagsOf({ tags: [] }), tagsOf({}));
  assert.deepEqual(tagsOf(undefined), tagsOf({}));
});
