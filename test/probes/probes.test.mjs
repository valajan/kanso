import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';

import accessibility from '../../src/modules/accessibility/index.js';
import { axeProbe, ruleIds } from '../../src/modules/accessibility/axe.js';
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

function probe(page, { modules = [accessibility], formFactor = 'mobile', config, timeoutMs } = {}) {
  return runProbes({ port: chrome.port, url: new URL(page, site.url).href, formFactor, settings: MOBILE, modules, config, timeoutMs });
}

// The accessibility module with one of its probes: each page is written for
// one probe, and may well trip another — a reflow page's off-screen menu is a
// keyboard failure.
function only(...probes) {
  return [{ id: 'accessibility', probes }];
}

// The findings of a rule axe settled — as opposed to the ones it only raised.
function broken({ findings }) {
  return findings.filter((finding) => !finding.needsReview);
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

// --- axe -------------------------------------------------------------------------

// axe run by Kanso rather than by Lighthouse. What is tested here is the part
// no fixture can stand in for: that 1.3 MB of axe reaches the page — and every
// frame of it — before its own scripts, whatever its Content-Security-Policy
// says, and that what axe hands back is turned into Kanso's elements.

test('a page breaking none of the hundred rules reports nothing', async () => {
  const { accessibility: result } = await probe('axe-clean.html', { modules: only(axeProbe) });
  assert.deepEqual(summary(result), []);
});

test('the rules Lighthouse switches off are reported, and an element in a frame with them', async () => {
  const { accessibility: result } = await probe('axe-beyond-lighthouse.html', { modules: only(axeProbe) });

  // What axe decided. What it could not decide is reported too, and is what
  // axe-unsettled.html is for: this page would otherwise have to promise never
  // to leave axe in doubt about anything, which is not a promise a page can
  // keep.
  assert.deepEqual(broken(result).map(({ rule, impact, count, detail, nodes }) => ({
    rule, impact, count, detail, at: nodes.map((node) => node.selector),
  })), [
    // Inside the iframe: axe reached it, and the element that failed stayed
    // there — its selector chain is what crossed back.
    { rule: 'image-alt', impact: 'critical', count: 1, detail: 'WCAG 1.1.1 (A)', at: ['iframe > img'] },
    { rule: 'role-img-alt', impact: 'serious', count: 1, detail: 'WCAG 1.1.1 (A)', at: ['body > main > div.glyph'] },
    { rule: 'scrollable-region-focusable', impact: 'serious', count: 1, detail: 'WCAG 2.1.1, 2.1.3 (A)', at: ['body > main > div.log'] },
    { rule: 'summary-name', impact: 'serious', count: 1, detail: 'WCAG 4.1.2 (A)', at: ['body > main > details > summary'] },
  ]);

  // axe's own account of the failure, as Lighthouse reports it too.
  assert.match(result.findings[1].nodes[0].explanation, /^Fix any of the following:\n  aria-label attribute does not exist or is empty/);
});

// Contrast and target size depend on the layout, and the layout depends on the
// screen: both loads run it, as Lighthouse ran axe on both.
test('axe runs on the desktop load too', async () => {
  const { accessibility: result } = await probe('axe-beyond-lighthouse.html', { modules: only(axeProbe), formFactor: 'desktop' });
  assert.deepEqual(broken(result).map((finding) => finding.rule), ['image-alt', 'role-img-alt', 'scrollable-region-focusable', 'summary-name']);
});

// The whole reason for running axe ourselves: Lighthouse keeps this answer and
// reports it for eleven of its sixty-six audits, dropping it for the rest. A
// contrast nobody can compute then reads as a contrast that passed.
test('a rule axe cannot settle is reported as a doubt, and cannot fail an audit on its own', async () => {
  const { accessibility: result } = await probe('axe-unsettled.html', { modules: only(axeProbe) });

  assert.deepEqual(result.findings.map(({ rule, impact, needsReview, count }) => ({ rule, impact, needsReview, count })), [
    // axe ranks this one `serious`; a doubt is capped, so that `fail_on:
    // serious` cannot be tripped by something nobody could decide.
    { rule: 'color-contrast', impact: 'moderate', needsReview: true, count: 1 },
  ]);
  assert.match(result.findings[0].nodes[0].explanation, /background color could not be determined due to a background image/);
});

// What a probe covers can now be a matter of configuration, and so can what
// goes unchecked when it fails: both are read from the same tags.
test('the rules the probe answers for follow the tags the project asked for', async () => {
  const dead = `http://127.0.0.1:${await closedPort()}/`;
  const run = (config) => runProbes({
    port: chrome.port, url: dead, formFactor: 'mobile', settings: MOBILE,
    modules: [{ id: 'accessibility', probes: [axeProbe] }], config,
  });

  const { accessibility: byDefault } = await run({});
  assert.deepEqual(byDefault.failures[0].rules, ruleIds());
  assert.equal(byDefault.failures[0].rules.length, 100);

  // Each module reads the section carrying its id, and nothing else.
  const { accessibility: narrowed } = await run({ accessibility: { tags: ['wcag2a'] }, seo: { tags: ['nonsense'] } });
  assert.deepEqual(narrowed.failures[0].rules, ruleIds(['wcag2a']));
  assert.ok(narrowed.failures[0].rules.length < 100);
  assert.ok(!narrowed.failures[0].rules.includes('region'), 'a best-practice rule is outside the set the project asked for');
});

// --- the declared states of a page ------------------------------------------------

// What only a click shows: a menu, a form behind it. The states are reached
// one from the other, in the page axe already loaded — no load of their own —
// and what is found in each says where.
const MENU = { name: 'menu', click: '#open', wait_for: "#open[aria-expanded='true']" };
const SIGNUP = { name: 'signup', click: '#signup', wait_for: '#form:not([hidden])' };

function where(result) {
  return broken(result).map(({ rule, at, count }) => [rule, at ?? null, count]);
}

test('axe reads the page again in each declared state, one reached from the other', async () => {
  const { accessibility: result } = await probe('states-menu.html', { modules: only(axeProbe), config: { states: [MENU, SIGNUP] } });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(where(result), [
    // As the page loads, the one fault it shows; the rest is hidden. The
    // image is still there in both states, and is not reported again: a
    // state reports what it adds.
    ['image-alt', null, 1],
    ['button-name', 'menu', 1],
    // The menu is still open — the states are cumulative — but its button
    // was reported where it appeared.
    ['label', 'signup', 1],
  ]);
});

test('a state that shows nothing new reports nothing', async () => {
  const { accessibility: result } = await probe('states-menu.html', {
    modules: only(axeProbe), config: { states: [MENU, { name: 'menu-again', click: '#open' }] },
  });
  assert.deepEqual(where(result), [['image-alt', null, 1], ['button-name', 'menu', 1]]);
  assert.deepEqual(result.failures, []);
});

test('a page read in no state is read as before', async () => {
  const { accessibility: result } = await probe('states-menu.html', { modules: only(axeProbe) });
  assert.deepEqual(where(result), [['image-alt', null, 1]]);
  assert.deepEqual(result.failures, []);
});

// Nothing found in a state nobody reached is nothing checked: that state, and
// every one after it — reached from it — are failures, never clean.
test('a state that cannot be reached stops the way through, and says which part was missing', async () => {
  const ghost = { name: 'ghost', click: '#nothing-here' };
  const { accessibility: result } = await probe('states-menu.html', {
    modules: only(axeProbe), config: { states: [MENU, ghost, SIGNUP] }, timeoutMs: 6_000,
  });

  assert.deepEqual(where(result), [['image-alt', null, 1], ['button-name', 'menu', 1]]);
  assert.deepEqual(result.failures.map(({ probe, at, error, rules }) => ({ probe, at, error, rules: rules.length })), [
    { probe: 'axe', at: 'ghost', error: 'nothing visible to click at #nothing-here', rules: 100 },
    { probe: 'axe', at: 'signup', error: 'not reached: ghost could not be', rules: 100 },
  ]);
});

test('a state whose click opens nothing says what never appeared', async () => {
  const stuck = { name: 'stuck', click: '#open', wait_for: '#never' };
  const { accessibility: result } = await probe('states-menu.html', { modules: only(axeProbe), config: { states: [stuck] }, timeoutMs: 6_000 });
  assert.deepEqual(result.failures.map(({ at, error }) => ({ at, error })), [{ at: 'stuck', error: 'clicked #open, and #never never appeared' }]);
});

test('a page that never loads reached none of its states either', async () => {
  const { accessibility: result } = await runProbes({
    port: chrome.port, url: `http://127.0.0.1:${await closedPort()}/`, formFactor: 'mobile', settings: MOBILE,
    modules: only(axeProbe), config: { states: [MENU, SIGNUP] },
  });
  assert.deepEqual(result.failures.map(({ at }) => at ?? null), [null, 'menu', 'signup']);
});

// Only a check that says so goes through the states: the others cost a load
// of their own, and that cost does not move.
test('a check that does not ask for the states runs on the page as it loads alone', async () => {
  const { accessibility: result } = await probe('states-menu.html', { modules: only(reflow), config: { states: [MENU] } });
  assert.deepEqual(result, { findings: [], failures: [] });
});

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
  assert.deepEqual(result.failures.map(({ probe, rules }) => ({ probe, rules: probe === 'axe' ? rules.length : rules })), [
    // Every rule of the set, unchecked: the module reads nothing from
    // Lighthouse any more, so a page that never answers leaves accessibility
    // entirely unknown — which is what must never read as a clean page.
    { probe: 'axe', rules: 100 },
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
