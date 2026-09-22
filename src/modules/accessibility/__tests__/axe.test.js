import { test } from 'node:test';
import assert from 'node:assert/strict';
import { axeFindings, ruleIds } from '../axe.js';

// The translation of what axe reports into what Kanso reports. What axe makes
// of a page runs in Chrome: see test/probes/ for that side, against a real
// browser.
const node = (selector) => ({ selector, snippet: `<p class="${selector}">`, label: 'text', path: `1,HTML,1,BODY,0,P`, explanation: 'Fix any of the following:\n  the contrast is 2.1:1' });

test('a page breaking no rule has no findings', () => {
  assert.deepEqual(axeFindings([]), []);
});

test('a broken rule becomes a finding, with axe’s own impact and every element it kept', () => {
  const [finding] = axeFindings([{
    id: 'color-contrast',
    help: 'Elements must meet minimum color contrast ratio thresholds',
    impact: 'serious',
    tags: ['cat.color', 'wcag2aa', 'wcag143'],
    count: 12,
    nodes: [node('faint'), node('fainter')],
  }]);

  assert.deepEqual(finding, {
    rule: 'color-contrast',
    title: 'Elements must meet minimum color contrast ratio thresholds',
    impact: 'serious',
    // The count is what the page does, not what was kept of it.
    count: 12,
    nodes: [node('faint'), node('fainter')],
    detail: 'WCAG 1.4.3 (AA)',
  });
});

// The `detail` line says what the rule answers to, so that nobody reads a law
// into a rule that is none, nor shrugs off one that is.
test('the criteria a rule covers are read off its tags, in order, at their level', () => {
  const detail = (tags) => axeFindings([{ id: 'r', help: 'h', impact: 'minor', tags, count: 0, nodes: [] }])[0].detail;

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
  assert.equal(axeFindings([{ id: 'r', help: 'h', impact: undefined, tags: [], count: 0, nodes: [] }])[0].impact, null);
});

// What the probe covers, and so what nobody checks when it fails. Read from
// axe itself — a list written by hand would drift at the next upgrade.
test('the rules the probe covers are the WCAG A/AA and best-practice sets', () => {
  const rules = ruleIds();

  assert.equal(rules.length, 100);
  assert.deepEqual(rules, [...rules].sort());
  // Three Lighthouse leaves out: an AA rule, a best-practice one, and the one
  // AAA rule axe can decide on its own.
  for (const rule of ['role-img-alt', 'region', 'identical-links-same-purpose']) assert.ok(rules.includes(rule), rule);
  // And one axe knows that nobody asked for: contrast at the AAA threshold.
  assert.ok(!rules.includes('color-contrast-enhanced'));
});
