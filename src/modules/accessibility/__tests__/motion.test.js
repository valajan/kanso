import { test } from 'node:test';
import assert from 'node:assert/strict';
import { motionFindings } from '../motion.js';

// What the page reports of its motion, which runs in Chrome: see test/probes/
// for the page side, against a real browser.
const element = (selector) => ({ selector, snippet: `<div class="${selector}">`, label: '', path: `1,HTML,1,BODY,${selector}` });

test('a page where nothing moves has no findings', () => {
  assert.deepEqual(motionFindings({ moving: [] }), []);
});

test('each element that moves is an element of the finding, with every motion it made', () => {
  const [finding] = motionFindings({
    moving: [
      { element: element('hero'), motions: [{ kind: 'animation', name: 'slide-in', properties: ['transform'], duration: 800, forever: false }] },
      { element: element('spinner'), motions: [{ kind: 'animation', name: 'spin', properties: ['transform'], duration: 1000, forever: true }] },
      { element: element('card'), motions: [
        { kind: 'transition', name: '', properties: ['transform'], duration: 500, forever: false },
        { kind: 'script', name: '', properties: ['translate', 'margin-top'], duration: 1000, forever: false },
      ] },
      { element: element('html'), motions: [{ kind: 'scroll' }] },
    ],
  });

  assert.equal(finding.rule, 'reduced-motion');
  assert.equal(finding.impact, 'moderate');
  assert.equal(finding.count, 4);
  assert.deepEqual(finding.nodes.map((node) => node.explanation), [
    'animation “slide-in” moves transform for 800ms',
    'animation “spin” moves transform forever',
    'transition of transform for 500ms; script animation of translate, margin-top for 1000ms',
    'scrolls smoothly (scroll-behavior: smooth)',
  ]);
});
