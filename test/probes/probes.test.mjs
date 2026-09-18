import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';

import accessibility from '../../src/modules/accessibility/index.js';
import { keyboard } from '../../src/modules/accessibility/keyboard.js';
import { motion } from '../../src/modules/accessibility/motion.js';
import { reflow } from '../../src/modules/accessibility/reflow.js';
import { runProbes } from '../../src/probes/index.js';
import { serveDirectory } from '../../src/serve/static.js';

// Kanso's probes, against a real Chrome, on pages whose answers are known.
//
// What runs in the page is a program of its own, sent as source: it only
// means something against a real layout engine, which `npm test` does not
// have. Each page in ./pages breaks one thing on purpose — or, for the clean
// ones, carries every pattern that looks like a failure and is not: a table
// wider than the screen, a code block with its own scrollbar, a carousel, a
// menu waiting off the screen, a visually hidden label, an ellipsis; a focus
// ring replaced by a shadow, an underline, a lit-up card, a skip link; motion
// kept for those who did not ask for less, a fade in its place.
//
//   npm run test:probes        (needs Chrome, ~20 s)

// Lighthouse's mobile emulation, as a report's configSettings carries it.
const MOBILE = {
  formFactor: 'mobile',
  screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
};

let chrome;
let site;

before(async () => {
  chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  await chrome.launch();
  site = await serveDirectory(fileURLToPath(new URL('./pages', import.meta.url)));
});

after(async () => {
  chrome?.kill();
  await site?.close();
});

function probe(page, { modules = [accessibility], formFactor = 'mobile', timeoutMs } = {}) {
  return runProbes({ port: chrome.port, url: new URL(page, site.url).href, formFactor, settings: MOBILE, modules, timeoutMs });
}

// The accessibility module with one of its probes: each page is written for
// one probe, and may well trip another — a reflow page's off-screen menu is a
// keyboard failure.
function only(...probes) {
  return [{ id: 'accessibility', probes }];
}

// What a finding says, in a form an assertion can hold.
function summary({ findings, failures }) {
  assert.deepEqual(failures, []);
  return findings.map((finding) => ({
    rule: finding.rule,
    count: finding.count,
    nodes: finding.nodes.map((node) => `${node.selector} — ${node.explanation}`),
  }));
}

// --- reflow -------------------------------------------------------------------------

test('a page that reflows reports nothing, whatever looks like overflow and is not', async () => {
  const { accessibility: result } = await probe('reflow-clean.html', { modules: only(reflow) });
  assert.deepEqual(summary(result), []);
});

test('a page scrolling sideways at 320 px names the box and the text that make it', async () => {
  const { accessibility: result } = await probe('reflow-scroll.html', { modules: only(reflow) });
  const [finding] = summary(result);

  assert.equal(finding.rule, 'reflow-scroll');
  assert.equal(finding.count, 2);
  assert.match(finding.nodes[0], /^body > main > div\.fixed-width — 400px wide, 96px past the right edge of the 320px viewport$/);
  assert.match(finding.nodes[1], /^body > main > pre\.yaml — its text runs \d+px past the right edge of the 320px viewport: “apiVersion: kanso\/v1/);
  assert.equal(result.findings[0].impact, 'serious');
});

test('text cut off by a box, or pushed past the end of a fixed bar, is lost', async () => {
  const { accessibility: result } = await probe('reflow-clip.html', { modules: only(reflow) });
  const [finding] = summary(result);

  assert.equal(finding.rule, 'reflow-clip');
  assert.deepEqual(finding.nodes.map((node) => node.replace(/\d+px/, 'Npx')), [
    'body > header > nav > a — “Changelog” runs Npx past the right edge of the screen, out of reach',
    'body > main > div.card — cuts off “apiVersion: kanso/v1 kind: Audit budget…”, Npx past its right edge',
  ]);
  assert.equal(result.findings[0].impact, 'moderate');
});

// The usual fix for a page that scrolls sideways, which trades the scroll for
// the content.
test('a page hiding its sideways overflow does not scroll, and loses what was past the edge', async () => {
  const { accessibility: result } = await probe('reflow-hidden.html', { modules: only(reflow) });

  assert.deepEqual(summary(result).map(({ rule, nodes }) => [rule, nodes.map((node) => node.replace(/\d+px/, 'Npx'))]), [
    ['reflow-clip', [
      'body > main > div.banner — “This banner is laid out 480 pixels wide…” runs Npx past the right edge of the screen, out of reach',
    ]],
  ]);
});

// 320 px is a width, not a device: the mobile load runs it, the desktop one
// has no probe to run.
test('reflow runs on the mobile load only', async () => {
  assert.deepEqual(await probe('reflow-scroll.html', { formFactor: 'desktop', modules: only(reflow) }), {});
});

// --- keyboard -------------------------------------------------------------------------

test('a page whose every stop shows its focus reports nothing, however it shows it', async () => {
  const { accessibility: result } = await probe('keyboard-clean.html', { modules: only(keyboard) });
  assert.deepEqual(summary(result), []);
});

test('focus nobody can see is named, with why', async () => {
  const { accessibility: result } = await probe('keyboard-unseen.html', { modules: only(keyboard) });

  assert.deepEqual(summary(result), [{
    rule: 'focus-visible',
    count: 4,
    nodes: [
      'body > nav.drawer > a.menu-link — focused while it is off the screen',
      'body > main > p > button.bare — focused with no visible change',
      'body > main > p > a.ghost — focused while it is invisible',
      'main > ul.folded > li > a.folded-link — focused while it is outside the visible part of its container',
    ],
  }]);
  assert.equal(result.findings[0].impact, 'serious');
});

// The browser scrolls a focused element into view only when it is off the
// screen: one already on it stays where it is, under whatever covers it.
test('focus behind a banner is named, with what covers it', async () => {
  const { accessibility: result } = await probe('keyboard-obscured.html', { modules: only(keyboard) });

  assert.deepEqual(summary(result), [{
    rule: 'focus-obscured',
    count: 1,
    nodes: ['body > main > section > a.low — entirely behind div.cookie-banner when focused'],
  }]);
});

test('focus sent back round a widget, or kept by it, is a trap', async () => {
  const cycle = await probe('keyboard-trap-cycle.html', { modules: only(keyboard) });
  assert.deepEqual(summary(cycle.accessibility), [{
    rule: 'focus-trap',
    count: 1,
    nodes: ['body > main > div.widget > button.first — Tab goes round 3 elements and back to this one, never leaving the page'],
  }]);
  assert.equal(cycle.accessibility.findings[0].impact, 'critical');

  const stuck = await probe('keyboard-trap-stuck.html', { modules: only(keyboard) });
  assert.deepEqual(summary(stuck.accessibility).map(({ nodes }) => nodes), [
    ['body > main > textarea.editor — Tab leaves focus on this element'],
  ]);
});

// Holding focus is what a modal dialog is for.
test('a modal dialog that holds focus is no trap', async () => {
  const { accessibility: result } = await probe('keyboard-dialog.html', { modules: only(keyboard) });
  assert.deepEqual(summary(result), []);
});

test('the keyboard walk runs on the desktop load too', async () => {
  const { accessibility: result } = await probe('keyboard-unseen.html', { modules: only(keyboard), formFactor: 'desktop' });
  assert.equal(summary(result)[0].rule, 'focus-visible');
});

// --- reduced motion -------------------------------------------------------------------

// What honours the preference: movement kept for those who did not ask for
// less, a fade in its place, a nudge shorter than a blink, a reveal by opacity.
test('a page that keeps still when asked reports nothing', async () => {
  const { accessibility: result } = await probe('motion-calm.html', { modules: only(motion) });
  assert.deepEqual(summary(result), []);
});

test('what moves anyway is named: on load, forever, from a script, on scroll, and smooth scrolling', async () => {
  const { accessibility: result } = await probe('motion-ignored.html', { modules: only(motion) });

  assert.deepEqual(summary(result), [{
    rule: 'reduced-motion',
    count: 5,
    nodes: [
      'body > main > p.scripted — script animation of transform for 1000ms',
      'body > main > h1.hero — animation “slide-in” moves transform for 800ms',
      'body > main > div.spinner — animation “spin” moves transform forever',
      'body > main > p.reveal — transition of transform for 500ms',
      'html — scrolls smoothly (scroll-behavior: smooth)',
    ],
  }]);
  assert.equal(result.findings[0].impact, 'moderate');
});

// --- the harness ----------------------------------------------------------------------

test('a probe that throws or never ends costs its own rules, and the others still run', async () => {
  const mod = {
    id: 'accessibility',
    probes: [
      { id: 'boom', rules: ['boom-rule'], run: () => { throw new Error('boom\nand a stack'); } },
      { id: 'stuck', rules: ['stuck-rule'], run: () => new Promise(() => {}) },
      reflow,
    ],
  };

  const { accessibility: result } = await probe('reflow-scroll.html', { modules: [mod], timeoutMs: 3000 });

  assert.deepEqual(result.failures, [
    { probe: 'boom', rules: ['boom-rule'], error: 'boom' },
    { probe: 'stuck', rules: ['stuck-rule'], error: 'timed out after 3s' },
  ]);
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['reflow-scroll']);
});

test('a page that never answers fails every probe, with what went wrong', async () => {
  const { accessibility: result } = await runProbes({
    port: chrome.port, url: `http://127.0.0.1:${await closedPort()}/`, formFactor: 'mobile', settings: MOBILE, modules: [accessibility],
  });

  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.failures.map(({ probe, rules }) => ({ probe, rules })), [
    { probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'] },
    { probe: 'keyboard', rules: ['focus-trap', 'focus-visible', 'focus-obscured'] },
    { probe: 'motion', rules: ['reduced-motion'] },
  ]);
  assert.match(result.failures[0].error, /ERR_CONNECTION_REFUSED/);
});

// A port nothing listens on: one the system just handed out, and took back.
function closedPort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
