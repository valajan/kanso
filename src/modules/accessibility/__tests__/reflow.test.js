import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reflowFindings } from '../reflow.js';

// What measureReflow reports of a page, which runs in Chrome: see
// test/probes/ for the page side, against a real layout.
const element = (selector) => ({ selector, snippet: `<div class="${selector}">`, label: '', path: `1,HTML,1,BODY,${selector}` });

test('a page that reflows has no findings', () => {
  assert.deepEqual(reflowFindings({ viewport: 320, scrolls: false, culprits: [], clipped: [] }), []);
});

test('a page scrolling sideways fails, on the boxes and the text that make it', () => {
  const [finding] = reflowFindings({
    viewport: 320,
    scrolls: true,
    culprits: [
      { element: element('wide'), width: 400, past: 96, side: 'right' },
      { element: element('pre'), text: 'apiVersion: kanso/v1', past: 293, side: 'right' },
    ],
    clipped: [],
  });

  assert.equal(finding.rule, 'reflow-scroll');
  assert.equal(finding.impact, 'serious');
  assert.equal(finding.title, 'Page scrolls sideways at 320 CSS pixels wide');
  assert.equal(finding.detail, 'WCAG 1.4.10 Reflow');
  assert.equal(finding.count, 2);
  assert.deepEqual(finding.nodes.map((node) => node.explanation), [
    '400px wide, 96px past the right edge of the 320px viewport',
    'its text runs 293px past the right edge of the 320px viewport: “apiVersion: kanso/v1”',
  ]);
  assert.equal(finding.nodes[0].path, '1,HTML,1,BODY,wide', 'the path is what tells two elements apart');
});

// Scrolling with nothing to point at is a table or an image — which WCAG lets
// need two dimensions — and says nothing worth a finding.
test('a page that scrolls only because of what may need two dimensions has no finding', () => {
  assert.deepEqual(reflowFindings({ viewport: 320, scrolls: true, culprits: [], clipped: [] }), []);
});

test('text cut off warns, by the box that cuts it or the screen', () => {
  const [finding] = reflowFindings({
    viewport: 320,
    scrolls: false,
    culprits: [],
    clipped: [
      { element: element('card'), text: 'budgets: { lcp: 2500 }', past: 120, side: 'right', by: 'element' },
      { element: element('nav'), text: 'Changelog', past: 78, side: 'right', by: 'viewport' },
    ],
  });

  assert.equal(finding.rule, 'reflow-clip');
  assert.equal(finding.impact, 'moderate');
  assert.deepEqual(finding.nodes.map((node) => node.explanation), [
    'cuts off “budgets: { lcp: 2500 }”, 120px past its right edge',
    '“Changelog” runs 78px past the right edge of the screen, out of reach',
  ]);
});

test('the element list is capped, the count is not', () => {
  const culprits = Array.from({ length: 150 }, (_, i) => ({ element: element(`box${i}`), width: 400, past: 80, side: 'right' }));
  const [finding] = reflowFindings({ viewport: 320, scrolls: true, culprits, clipped: [] });
  assert.equal(finding.count, 150);
  assert.equal(finding.nodes.length, 100);
});
