import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyboardFindings } from '../keyboard.js';

// What the keyboard walk records of a page, which runs in Chrome: see
// test/probes/ for the page side, against a real browser.
const element = (selector) => ({ selector, snippet: `<a class="${selector}">`, label: selector, path: `1,HTML,1,BODY,${selector}` });
const stop = (selector, extra = {}) => ({ element: element(selector), indicator: true, hidden: null, coveredBy: null, ...extra });

test('a walk where every stop shows its focus has no findings', () => {
  assert.deepEqual(keyboardFindings({ stops: [stop('a'), stop('b')], trap: null, end: 'left' }), []);
});

test('a stop with no sign of focus, or out of sight when focused, is a failure of focus-visible', () => {
  const [finding] = keyboardFindings({
    stops: [stop('ok'), stop('bare', { indicator: false }), stop('drawer', { hidden: 'it is off the screen' })],
    trap: null,
  });

  assert.equal(finding.rule, 'focus-visible');
  assert.equal(finding.impact, 'serious');
  assert.equal(finding.detail, 'WCAG 2.4.7 Focus Visible');
  assert.equal(finding.count, 2);
  assert.deepEqual(finding.nodes.map((node) => [node.selector, node.explanation]), [
    ['bare', 'focused with no visible change'],
    ['drawer', 'focused while it is off the screen'],
  ]);
});

// Hidden is the stronger fault: an element out of sight is not also "behind"
// what happens to be where it is not.
test('a stop covered when focused is focus-obscured, unless it is out of sight anyway', () => {
  const findings = keyboardFindings({
    stops: [stop('low', { coveredBy: 'div.cookie-banner' }), stop('gone', { hidden: 'it is invisible', coveredBy: 'header' })],
    trap: null,
  });

  const obscured = findings.find((f) => f.rule === 'focus-obscured');
  assert.equal(obscured.impact, 'moderate');
  assert.deepEqual(obscured.nodes.map((node) => node.explanation), ['entirely behind div.cookie-banner when focused']);
});

test('a trap is one finding, on where focus goes round or stays', () => {
  const [cycle] = keyboardFindings({ stops: [stop('first'), stop('last')], trap: { kind: 'cycle', size: 2, element: element('first') } });
  assert.equal(cycle.rule, 'focus-trap');
  assert.equal(cycle.impact, 'critical');
  assert.equal(cycle.nodes[0].explanation, 'Tab goes round 2 elements and back to this one, never leaving the page');

  const [stuck] = keyboardFindings({ stops: [stop('editor')], trap: { kind: 'stuck', element: element('editor') } });
  assert.equal(stuck.nodes[0].explanation, 'Tab leaves focus on this element');
});
