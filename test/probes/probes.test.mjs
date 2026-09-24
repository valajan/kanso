import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';

import accessibility from '../../src/modules/accessibility/index.js';
import { axeProbe, ruleIds } from '../../src/modules/accessibility/axe.js';
import { focus } from '../../src/modules/accessibility/focus.js';
import { leaks } from '../../src/modules/interactions/leaks.js';
import { residues } from '../../src/modules/interactions/residues.js';
import { keyboard } from '../../src/modules/accessibility/keyboard.js';
import { motion } from '../../src/modules/accessibility/motion.js';
import { reflow } from '../../src/modules/accessibility/reflow.js';
import performance from '../../src/modules/performance/index.js';
import { runProbes } from '../../src/probes/index.js';
import { Journal } from '../../src/probes/journal.js';
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
  throttling: { cpuSlowdownMultiplier: 4 },
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

function probe(page, { modules = [accessibility], formFactor = 'mobile', settings = MOBILE, config, measuresOnly, timeoutMs, journal } = {}) {
  return runProbes({ port: chrome.port, url: new URL(page, site.url).href, formFactor, settings, modules, config, measuresOnly, timeoutMs, journal });
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
  assert.equal(byDefault.failures[0].rules.length, 101);

  // Each module reads the section carrying its id, and nothing else.
  const { accessibility: narrowed } = await run({ accessibility: { tags: ['wcag2a'] }, seo: { tags: ['nonsense'] } });
  assert.deepEqual(narrowed.failures[0].rules, ruleIds(['wcag2a']));
  assert.ok(narrowed.failures[0].rules.length < 101);
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
    { probe: 'axe', at: 'ghost', error: 'nothing visible to click at #nothing-here', rules: 101 },
    { probe: 'axe', at: 'signup', error: 'not reached: ghost could not be', rules: 101 },
  ]);
});

test('a state whose click opens nothing says what never appeared', async () => {
  const stuck = { name: 'stuck', click: '#open', wait_for: '#never' };
  const { accessibility: result } = await probe('states-menu.html', { modules: only(axeProbe), config: { states: [stuck] }, timeoutMs: 6_000 });
  assert.deepEqual(result.failures.map(({ at, error }) => ({ at, error })), [{ at: 'stuck', error: 'clicked #open, and #never never appeared' }]);
});

// The journal: what a probe went through, in order — for whoever wants to see
// it done, not only its verdict.
test('the journal follows a probe through its states, and keeps what it found where', async () => {
  const journal = new Journal();
  const ghost = { name: 'ghost', click: '#nothing-here' };
  await probe('states-menu.html', { modules: only(axeProbe), config: { states: [MENU, ghost] }, timeoutMs: 6_000, journal });

  assert.deepEqual(journal.events.filter((e) => e.kind !== 'finding').map((e) => [e.kind, e.probe, e.at ?? null]), [
    ['probe-start', 'axe', null],
    ['loaded', 'axe', null],
    ['state-reached', 'axe', 'menu'],
    ['state-unreached', 'axe', 'ghost'],
    ['probe-end', 'axe', null],
  ]);
  const found = journal.events.filter((e) => e.kind === 'finding' && !e.needsReview).map((e) => [e.rule, e.at ?? null, e.nodes.length]);
  assert.deepEqual(found, [['image-alt', null, 1], ['button-name', 'menu', 1]]);
  assert.deepEqual(journal.events.at(-1).unreached, ['ghost']);
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

// --- transitions ----------------------------------------------------------------------

// The way into and out of each state, for a probe that checks it rather than
// the state itself. A probe of the tests' own, which tries the tools every
// such check has — open by key, else by click; where focus is; close — and
// reports what they said.
const MENU_T = { name: 'menu', click: '#menu-button', wait_for: "#menu-button[aria-expanded='true']" };
const SETTINGS_T = { name: 'settings', click: '#settings-button', wait_for: 'dialog[open]' };
const MORE_T = { name: 'more', click: '#more', wait_for: '#panel:not([hidden])' };

function transitionRecorder() {
  const seen = [];
  const recorder = {
    id: 'recorder',
    rules: ['recorded'],
    transitions: true,
    async transition(page, state, tools) {
      const trigger = await tools.trigger();
      const { opened, key, focusable, kind } = await tools.open({ by: 'keyboard' });
      const byKey = { opened, key, focusable };
      if (!opened) await tools.open();
      const inside = await tools.focused('opened');
      const escaped = await tools.close();
      const after = await tools.focused('closed');
      const declared = await tools.close({ by: 'close' });
      seen.push({
        state: state.name,
        trigger: trigger.selector,
        byKey,
        kind,
        inside: inside?.selector ?? null,
        escaped: escaped.closed,
        after: after?.selector ?? null,
        declared: declared.closed,
      });
      return [{ rule: 'recorded', title: 'Recorded', impact: 'minor', count: 1, nodes: [trigger] }];
    },
  };
  return { recorder, seen };
}

test('a transition probe goes into and out of each state, in a page brought to the state before', async () => {
  const { recorder, seen } = transitionRecorder();
  const journal = new Journal();
  const { accessibility: result } = await probe('transitions.html', { modules: only(recorder), config: { states: [MENU_T, SETTINGS_T] }, journal });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(seen, [
    {
      // Enter opens the menu, focus stays on its button, Escape closes it.
      state: 'menu', trigger: 'body > main > button#menu-button', byKey: { opened: true, key: 'Enter', focusable: true }, kind: 'disclosure',
      inside: 'body > main > button#menu-button', escaped: true, after: 'body > main > button#menu-button', declared: null,
    },
    {
      // Reached from the menu, in a page of its own: the dialog takes focus
      // as it opens and gives it back as it closes.
      state: 'settings', trigger: 'body > main > nav#menu > button#settings-button', byKey: { opened: true, key: 'Enter', focusable: true }, kind: 'modal',
      inside: 'body > main > dialog#settings > button#settings-close', escaped: true, after: 'body > main > nav#menu > button#settings-button', declared: null,
    },
  ]);
  assert.deepEqual(result.findings.map(({ rule, at }) => [rule, at]), [['recorded', 'menu'], ['recorded', 'settings']]);

  // The journal shows each transition as it went: the settings' page loaded,
  // the menu reached on the way, then in and out of the dialog.
  const lastPage = journal.events.slice(journal.events.findLastIndex((e) => e.kind === 'loaded'));
  assert.deepEqual(lastPage.map((e) => [e.kind === 'focus' ? `focus ${e.why}` : e.kind, e.at]), [
    ['loaded', 'settings'], ['state-reached', 'menu'], ['open', 'settings'], ['focus opened', 'settings'],
    ['close', 'settings'], ['focus closed', 'settings'], ['close', 'settings'], ['finding', 'menu'], ['finding', 'settings'], ['probe-end', undefined],
  ]);
});

test('a state no key opens says so, and the click still opens it; one nothing closes, says that', async () => {
  const { recorder, seen } = transitionRecorder();
  const { accessibility: result } = await probe('transitions.html', { modules: only(recorder), config: { states: [MORE_T] } });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(seen.map(({ byKey, escaped, declared }) => ({ byKey, escaped, declared })), [
    { byKey: { opened: false, key: null, focusable: false }, escaped: false, declared: null },
  ]);
});

test('a state a transition probe cannot check costs that state, and the ones beyond it', async () => {
  const { recorder } = transitionRecorder();
  const ghost = { name: 'ghost', click: '#nothing-here' };
  const { accessibility: result } = await probe('transitions.html', {
    modules: only(recorder), config: { states: [MENU_T, ghost, SETTINGS_T] }, timeoutMs: 6_000,
  });

  assert.deepEqual(result.findings.map(({ at }) => at), ['menu']);
  assert.deepEqual(result.failures.map(({ at, error }) => ({ at, error })), [
    { at: 'ghost', error: 'nothing visible to click at #nothing-here' },
    { at: 'settings', error: 'not reached: ghost could not be (nothing visible to click at #nothing-here)' },
  ]);
});

test('a transition probe needs a state, and does not run without one', async () => {
  const { recorder, seen } = transitionRecorder();
  assert.deepEqual(await probe('transitions.html', { modules: only(recorder) }), {});
  assert.deepEqual(seen, []);
});

// --- focus, on the way into and out of each state ---------------------------------

// Each state alone: the states are cumulative, and a modal dialog left open
// would stand between the next state's click and its trigger.
async function focusIn(page, state) {
  const { accessibility: result } = await probe(page, { modules: only(focus), config: { states: [state] } });
  assert.deepEqual(result.failures, []);
  return result.findings.map((finding) => [finding.rule, finding.at, finding.nodes[0].selector, finding.nodes[0].explanation]);
}

test('focus handled on the way in and out reports nothing, however it is handled', async () => {
  for (const state of [
    // The browser's own modal dialog.
    { name: 'native', click: '#native-open', wait_for: 'dialog#native[open]' },
    // A dialog of its own, focus sent to its title after a 300 ms transition,
    // the page behind made inert.
    { name: 'custom', click: '#custom-open', wait_for: '#custom:not([hidden])' },
    // A disclosure, whose content is next, and which Escape need not close.
    { name: 'disclosure', click: '#faq', wait_for: "#faq[aria-expanded='true']" },
    // A menu button: focus on the first item, back on Escape.
    { name: 'menu', click: '#actions', wait_for: "#actions[aria-expanded='true']" },
    // Load more: gone once it loaded, focus on the first new item.
    { name: 'more', click: '#load-more', wait_for: '#item-4' },
    // A popover that is not modal, and keeps focus where it was.
    { name: 'popover', click: '#tip-open', wait_for: '#tip:popover-open' },
    // Modal the way component libraries make it: the page behind hidden.
    { name: 'sheet', click: '#sheet-open', wait_for: '#sheet:not([hidden])' },
  ]) {
    assert.deepEqual(await focusIn('focus-clean.html', state), [], state.name);
  }
});

test('a modal dialog in name only: focus behind it, Tab under it, Escape ignored, focus lost as it closes', async () => {
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'lazy', click: '#lazy-open', wait_for: '#lazy:not([hidden])', close: '#lazy-close' }), [
    ['focus-not-moved', 'lazy', 'body > div#lazy', 'focus stayed on body > main#page > button#lazy-open'],
    // Walked from inside the dialog: Tab gets out of it, to the top of the
    // page.
    ['focus-escapes-modal', 'lazy', 'body > a#skip', 'Tab reached it, behind the open body > div#lazy'],
    ['escape-not-closing', 'lazy', 'body > div#lazy', 'still open after Escape'],
    ['focus-lost', 'lazy', 'body > main#page > button#lazy-open', 'closing what it opened left focus nowhere'],
  ]);
});

// The pattern of a real drawer: modal by the page behind it being hidden,
// with focus left there.
test('a dialog made modal by hiding the page behind it, which leaves focus behind', async () => {
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'drawer', click: '#drawer-open', wait_for: '#drawer:not([hidden])' }), [
    ['focus-not-moved', 'drawer', 'body > div#drawer', 'focus stayed on body > main#page > button#drawer-open'],
  ]);
});

test('what a click opens and no key can, and what goes as it opens, taking focus with it', async () => {
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'mouse', click: '#mouse', wait_for: '#mouse-panel:not([hidden])' }), [
    ['keyboard-inoperable', 'mouse', 'body > main#page > div#mouse', 'takes no keyboard focus, and only a click opens what it opens'],
  ]);
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'vanish', click: '#vanish', wait_for: '#vanished-panel:not([hidden])' }), [
    ['focus-lost', 'vanish', 'body > main#page > button#vanish', 'opening what it opens left focus nowhere'],
  ]);
});

test('a disclosure whose content is at the end of the page, and a dialog that sends focus elsewhere as it closes', async () => {
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'portal', click: '#portal-open', wait_for: "#portal-open[aria-expanded='true']" }), [
    ['revealed-unreachable', 'portal', 'body > main#page > button#portal-open', 'the next Tab goes to body > main#page > a, not into body > div#portal'],
  ]);
  assert.deepEqual(await focusIn('focus-broken.html', { name: 'noreturn', click: '#nr-open', wait_for: 'dialog#nr[open]' }), [
    ['focus-not-returned', 'noreturn', 'body > main#page > button#nr-open', 'focus went to body > a#skip when what it opened closed'],
  ]);
});

// --- what a state leaves behind, and keeps in memory -----------------------------

// Each state alone, as for focus.
async function leftBy(page, state, check = residues) {
  const { accessibility: result } = await probe(page, { modules: only(check), config: { states: [state] } });
  assert.deepEqual(result.failures, []);
  return result.findings.map((finding) => [finding.rule, finding.nodes[0].selector, finding.nodes[0].explanation]);
}

test('states that give the page back as they found it leave nothing, and keep nothing', async () => {
  for (const state of [
    // The browser's modal dialog, the page locked behind it by CSS alone.
    { name: 'native', click: '#native-open', wait_for: 'dialog#native[open]' },
    // Locks, hides and covers the page while open; gives it all back.
    { name: 'sheet', click: '#sheet-open', wait_for: '#sheet' },
    // Closed by a click away from it, Escape doing nothing.
    { name: 'menu', click: '#menu-open', wait_for: '#menu:not([hidden])' },
    // Builds two hundred items the first time, and keeps them: a cache.
    { name: 'cached', click: '#cached-open', wait_for: '#cached:not([hidden])' },
  ]) {
    assert.deepEqual(await leftBy('interactions-clean.html', state), [], `${state.name}, residues`);
  }
  for (const name of ['cached', 'sheet']) {
    const state = name === 'cached'
      ? { name, click: '#cached-open', wait_for: '#cached:not([hidden])' }
      : { name, click: '#sheet-open', wait_for: '#sheet' };
    assert.deepEqual(await leftBy('interactions-clean.html', state, leaks), [], `${name}, leaks`);
  }
});

test('what a closed state leaves: a locked page, a backdrop, a hidden page, a lost place, a stale button', async () => {
  const dialog = (name) => ({ name, click: `#${name}-open`, wait_for: `#${name}-open-dialog` });
  assert.deepEqual(await leftBy('interactions-broken.html', dialog('locked')), [
    ['page-locked', 'body', 'overflow: hidden on <body>, which it did not have before'],
  ]);
  assert.deepEqual(await leftBy('interactions-broken.html', dialog('scrim')), [
    ['overlay-left', 'body > div.scrim', 'covers 100% of the screen and takes the clicks at its middle'],
  ]);
  assert.deepEqual(await leftBy('interactions-broken.html', dialog('hidden')), [
    ['page-hidden-left', 'body > main#page', 'still aria-hidden once the state closed'],
  ]);
  const [[rule, , explanation]] = await leftBy('interactions-broken.html', dialog('jump'));
  assert.equal(rule, 'scroll-position-lost');
  assert.match(explanation, /^the page was scrolled to \d+ px, and is at 0 px once the state closed$/);
  assert.deepEqual(await leftBy('interactions-broken.html', { name: 'stale', click: '#stale-open', wait_for: '#stale:not([hidden])' }), [
    ['expanded-left', 'body > main#page > button#stale-open', 'aria-expanded is still true'],
  ]);
});

test('an address left changed, an error on closing, a page that scrolls behind a modal dialog', async () => {
  const dialog = (name) => ({ name, click: `#${name}-open`, wait_for: `#${name}-open-dialog` });
  const [hash] = await leftBy('interactions-broken.html', dialog('hash'));
  assert.equal(hash[0], 'url-left');
  assert.match(hash[2], /to http:\/\/127\.0\.0\.1:\d+\/interactions-broken\.html#newsletter$/);
  assert.deepEqual(await leftBy('interactions-broken.html', dialog('throws')), [
    ['close-error', 'body > main#page > button#throws-open', 'cleanup failed'],
  ]);
  assert.deepEqual(await leftBy('interactions-broken.html', dialog('loose')), [
    ['scroll-not-locked', 'body > div#loose-open-dialog', 'the page behind it scrolled 400 px under the wheel'],
  ]);
});

test('a state that keeps what it built on every opening, and a listener on each, leaks', async () => {
  // Fifty items and their text on each opening, fifty listeners: the counts
  // the page starts from are Chrome's business, what each opening adds is not.
  const [dom, listeners] = await leftBy('interactions-broken.html', { name: 'leaky', click: '#leaky-open', wait_for: '#leaky:not([hidden])' }, leaks);
  assert.equal(dom[0], 'dom-leak');
  assert.match(dom[2], /^DOM nodes went from \d+ to \d+ over 6 more cycles — 100 kept per opening$/);
  assert.equal(listeners[0], 'listener-leak');
  assert.match(listeners[2], /^event listeners went from \d+ to \d+ over 6 more cycles — 50 added per opening$/);
});

// --- keyboard -------------------------------------------------------------------------

test('a page whose every stop shows its focus reports nothing, however it shows it', async () => {
  const { accessibility: result } = await probe('keyboard-clean.html', { modules: only(keyboard) });
  assert.deepEqual(summary(result), []);
});

test('focus nobody can see is named, with why', async () => {
  const journal = new Journal();
  const { accessibility: result } = await probe('keyboard-unseen.html', { modules: only(keyboard), journal });

  // Every stop of the walk is in the journal, the unseen ones as such.
  const stops = journal.events.filter((e) => e.kind === 'tab-stop');
  assert.equal(stops.filter((stop) => !stop.indicator || stop.hidden).length, 4);
  assert.deepEqual(stops.map((stop) => stop.index), stops.map((_, i) => i));
  assert.equal(journal.events.find((e) => e.kind === 'tab-end').stops, stops.length);

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

// --- INP -----------------------------------------------------------------------------

// Two clicks, declared as states: one the page answers at once, one it holds
// the main thread 300 ms for. The INP is the slow one, and its time is in the
// handler.
const QUICK = { name: 'quick', click: '#quick', wait_for: "#quick[aria-expanded='true']" };
const SLOW = { name: 'slow', click: '#slow', wait_for: '#said:not([hidden])' };

test('each declared click is timed, and the slowest names what it landed on and where its time went', async () => {
  const { performance: result } = await probe('inp-slow.html', { modules: [performance], config: { states: [QUICK, SLOW] } });

  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.measures.map(({ at }) => at), ['quick', 'slow']);

  const [quick, slow] = result.measures;
  assert.ok(quick.latency < 100, `the quick click took ${quick.latency}ms`);
  assert.equal(slow.type, 'click');
  assert.equal(slow.target.selector, 'body > main > button#slow');
  assert.ok(slow.latency >= 300 && slow.latency < 450, `the slow click took ${slow.latency}ms`);
  assert.ok(slow.processing >= 300, `its handler ran ${slow.processing}ms`);
  assert.ok(Math.abs(slow.inputDelay + slow.processing + slow.presentation - slow.latency) <= 1);
});

// Timed on the machine running the audit, a click says nothing of a phone.
// The same work is done on both loads; the mobile one does it on a CPU slowed
// as Lighthouse says, the desktop one on the CPU as it is.
test('the CPU is slowed as Lighthouse slows it, for the probe that times', async () => {
  const states = [{ name: 'work', click: '#work', wait_for: '#done:not([hidden])' }];
  const time = async (multiplier) => {
    const settings = { ...MOBILE, throttling: { cpuSlowdownMultiplier: multiplier } };
    const { performance: result } = await probe('inp-work.html', { modules: [performance], settings, config: { states } });
    return result.measures[0].processing;
  };

  const fast = await time(1);
  const slowed = await time(4);
  assert.ok(slowed > fast * 2, `slowed ${slowed}ms, against ${fast}ms`);
});

// Nothing clicked, nothing timed: the probe does not load the page for
// nothing, and INP is not measured rather than zero.
test('with no state declared, INP is not timed at all', async () => {
  assert.deepEqual(await probe('inp-slow.html', { modules: [performance] }), {});
});

test('a click that cannot be made leaves its state, and the ones after it, untimed', async () => {
  const ghost = { name: 'ghost', click: '#nothing-here' };
  const { performance: result } = await probe('inp-slow.html', {
    modules: [performance], config: { states: [QUICK, ghost, SLOW] }, timeoutMs: 6_000,
  });

  assert.deepEqual(result.measures.map(({ at }) => at), ['quick']);
  assert.deepEqual(result.failures.map(({ probe, at, rules }) => ({ probe, at, rules })), [
    { probe: 'inp', at: 'ghost', rules: ['inp'] },
    { probe: 'inp', at: 'slow', rules: ['inp'] },
  ]);
});

// The loads after the first run the probes that measure, and those alone:
// a median needs a number from each load; a finding does not change.
test('on a repeated load, only the probe that measures runs', async () => {
  const result = await probe('inp-slow.html', {
    modules: [performance, only(axeProbe)[0]], config: { states: [SLOW] }, measuresOnly: true,
  });
  assert.deepEqual(Object.keys(result), ['performance']);
  assert.equal(result.performance.measures.length, 1);
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
    { probe: 'axe', rules: 101 },
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
