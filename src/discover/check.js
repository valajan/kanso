import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';

import { pathTo, statesOn, walkOrder } from '../config/states.js';
import { launchedPid, stopOnExit } from '../process/children.js';
import { NO_JOURNAL } from '../probes/journal.js';
import { applyState, reach } from '../probes/states.js';
import { backTo, broughtBy, capped, families, keyOf, samePage, without } from './explore.js';
import { contentDiff, diff } from './fingerprint.js';
import { describeStopped, stoppedBy } from './guards.js';
import { load, openPage, prepare, settle } from './page.js';
import { selectorFor } from './selectors.js';

// The states someone else proposes, checked against the page: the coding
// agent that wrote the page has its source, and knows what opens what better
// than a click-through guessing from outside. It writes `states:` — the shape
// .kanso.yml takes (src/config/states.js) — and Kanso replays each one, the
// way an audit will, and says what it found there. Nothing here explores:
// what is not proposed is not looked for, and nothing here judges whether a
// state is worth auditing. Facts, for the agent to act on.
//
// Each state is reached from a first visit, in a page of its own, down its
// path (`pathTo`), on each screen it is on (`statesOn`: a state with
// `form_factor:` on that screen alone, the states under it with it) — in a
// guarded page, as `kanso discover` replays what it found (./index.js): a
// state whose click the guards had to stop is not reached, since an audit,
// which has no guard, would send the write, follow the navigation, leave the
// `confirm()` for nobody to answer. The page's own beacons are not held
// against it (./guards.js, `stoppedBy`).
//
// For each state, on each screen:
//
//   reached     — or, when not, the `step` it failed at: `path` (a state it
//                 starts from, named in `through`), `click` (nothing visible
//                 to click), `wait_for` (what says it opened never did),
//                 `guards` (what was stopped, in `stopped`), `left` (the
//                 click changed the page's address, as an app changing route
//                 does: another page, not a state of this one) — and the
//                 `reason`, in words. A state under one not reached is not
//                 tried: it is not reached, through it.
//   click       — how many elements its selector matches, how many of them
//                 are visible, and whether the first is: Puppeteer clicks the
//                 first match, once visible, and a selector matching two is a
//                 state that follows the page's order. The element clicked,
//                 by role and name, and the steadiest selector that finds it
//                 alone (./selectors.js), which the agent can adopt — and
//                 `refused`, when the rules the explorer clicks by would not
//                 have let it touch that element (./guards.js, `verdict`).
//                 A first match hidden before a shown one fails the click;
//                 the shown one is then described as `visibleMatch`.
//   waitFor     — how many elements `wait_for` matches before the click and
//                 after: one already there before waits for nothing.
//   changed     — what the state shows that the one it starts from did not:
//                 the controls that `appeared` and `disappeared`, by role,
//                 name and ARIA state, the dialogs, the `newText` — less what
//                 two first visits of the page disagree on, as the
//                 exploration leaves it out (./page.js, `prepare`). A click
//                 that changes nothing is no state.
//   duplicates  — the state, earlier on the same screen, that this one ends
//                 at too: two buttons opening the same dialog.
//   revealed    — what can be clicked in the state that was not there before
//                 it: each by role, name and steadiest selector, one per
//                 family (./explore.js, `families`, with `alike` saying how
//                 many a family holds) — what the agent needs to propose the
//                 states under it without guessing.
//   close       — when the state has one: whether clicking it brings the
//                 page back to where the state started (./explore.js,
//                 `backTo`), with nothing the guards must stop.
//   closesParent — the state it starts from, when its click brings the page
//                 back to where it loaded: a dialog's ×, proposed as a state
//                 under the dialog. No state, but what closes one — the
//                 `close:` of the state it is under — and a duplicate of the
//                 page as it loads, which is audited already.
//
// Resolves to { url, screens: { [formFactor]: { stable, drift, states } },
// summary } — plain data, what the agent is handed as it is.

const WAIT_MS = 5_000;

// How many elements a state's `revealed` lists: what a menu or a dialog
// brings, and the start of what a page swapped whole.
const MAX_REVEALED = 30;

export async function checkStates(url, states, { formFactors = ['mobile', 'desktop'], onProgress = () => {} } = {}) {
  // Launched as ./index.js launches it, and for the same reasons: by hand, so
  // that a Chrome whose port never opened is killed all the same, and
  // stopped should Kanso be interrupted (src/process/children.js).
  const chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  let browser;
  const release = stopOnExit(() => launchedPid(chrome));
  try {
    await chrome.launch();
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });

    // The two screens side by side; a screen's states one after the other.
    const screens = Object.fromEntries(await Promise.all(formFactors.map(async (formFactor) => {
      const prep = await prepare(browser, formFactor, url);
      const checked = await walk(states, formFactor, (state, path) => replayOne(browser, formFactor, url, prep, state, path), {
        onState: (entry, done, total) => onProgress({ formFactor, state: entry.name, reached: entry.reached, done, total }),
      });
      return [formFactor, {
        stable: prep.stable,
        drift: { appeared: capped(prep.drift.appeared), disappeared: capped(prep.drift.disappeared) },
        states: checked,
      }];
    })));
    return { url, screens, summary: summarize(screens) };
  } finally {
    await browser?.disconnect().catch(() => {});
    chrome.kill();
    release();
  }
}

// One screen's states, in the order a walk takes them (`walkOrder`), each
// handed to `replay(state, path)` — `path` the states it is reached through —
// unless a state it starts from was not reached, and each told apart from
// the ones before it that ended where it does. What `replay` resolves to is
// the entry, less `key`: what tells where a state ends, which only this
// comparison reads.
export async function walk(states, formFactor, replay, { onState = () => {} } = {}) {
  const on = statesOn(states, formFactor);
  const order = walkOrder(on);
  const lost = new Set();
  const seen = new Map();
  const out = [];
  for (const state of order) {
    const path = pathTo(on, state);
    const head = { name: state.name, from: state.from ?? null, path: path.map((s) => s.name) };
    let entry;
    if (state.from != null && lost.has(state.from)) {
      entry = { ...head, reached: false, step: 'path', through: state.from, reason: `reached through ${state.from}, which was not reached` };
    } else {
      const { key, ...facts } = await replay(state, path);
      entry = { ...head, ...facts };
      // A state that changed nothing is the page it started from, and says
      // so already: it duplicates no other.
      // Nor does one that closes the state it starts from: that says more.
      if (entry.reached) {
        const distinct = entry.changed && !entry.closesParent;
        entry.duplicates = distinct ? seen.get(key) ?? null : null;
        if (distinct && !seen.has(key)) seen.set(key, state.name);
      }
    }
    if (!entry.reached) lost.add(state.name);
    out.push(entry);
    onState(entry, out.length, order.length);
  }
  return out;
}

// What the states came to, counted over every state on every screen it is
// on: what a command turns into an exit code. `ok` when each was reached,
// changed something, is no other's duplicate, closes no other and closes by
// its `close:` —
// a selector that matches more than one element, or a `wait_for` that waits
// for nothing, is worth fixing but replays all the same, and is only
// counted.
export function summarize(screens) {
  const all = Object.values(screens).flatMap((s) => s.states);
  const reached = all.filter((s) => s.reached);
  const summary = {
    checked: all.length,
    reached: reached.length,
    unreached: all.length - reached.length,
    unchanged: reached.filter((s) => !s.changed).length,
    duplicates: reached.filter((s) => s.duplicates).length,
    closesParent: reached.filter((s) => s.closesParent).length,
    closeBroken: reached.filter((s) => s.close && !s.close.closed).length,
    ambiguous: all.filter((s) => s.click?.matches > 1).length,
    waitsForNothing: all.filter((s) => s.waitFor?.matchesBefore > 0).length,
  };
  summary.ok = summary.unreached + summary.unchanged + summary.duplicates + summary.closesParent + summary.closeBroken === 0;
  return summary;
}

// One state reached in a page of its own, from a first visit: its path, then
// its own click, read before and after.
async function replayOne(browser, formFactor, url, prep, state, path) {
  const { unprompted, volatile } = prep;
  const tab = await openPage(browser, formFactor);
  try {
    await load(tab, url);

    // The states it starts from, reached again: each was reached in a page of
    // its own already, but a page may not do twice what it did once.
    try {
      await reach(tab.page, path, { waitMs: WAIT_MS, log: NO_JOURNAL });
    } catch (err) {
      return { reached: false, step: 'path', through: err.state?.name ?? null, reason: firstLine(err) };
    }
    const onTheWay = stoppedBy(tab.guard.blocked, unprompted);
    if (onTheWay.length > 0) {
      return { reached: false, step: 'path', through: path.at(-1)?.name ?? null, reason: 'the guards stopped what the way to it did', stopped: onTheWay.map((b) => describeStopped(b, url)) };
    }

    const start = await settle(tab.page);
    const click = await describeClick(tab.page, start, state.click);
    const matchesBefore = state.waitFor ? await count(tab.page, state.waitFor) : null;
    const blockedBefore = tab.guard.blocked.length;
    const address = tab.page.url();
    let failure = null;
    try {
      await applyState(tab.page, state, { waitMs: WAIT_MS });
    } catch (err) {
      failure = err;
    }
    const after = await settle(tab.page);
    const stopped = stoppedBy(tab.guard.blocked.slice(blockedBefore), unprompted).map((b) => describeStopped(b, url));
    const waitFor = state.waitFor ? { selector: state.waitFor, matchesBefore, matches: await count(tab.page, state.waitFor) } : null;
    const facts = { click, ...(waitFor ? { waitFor } : {}) };

    // The guards first: a wait that never ended after a write was stopped
    // says less than the write.
    if (stopped.length > 0) {
      return { reached: false, step: 'guards', reason: `the guards stopped what the click did (${stopped.join(', ')})`, stopped, ...facts };
    }
    if (failure) return { reached: false, step: failure.step ?? 'click', reason: firstLine(failure) + whyNotClicked(failure, click), ...facts };
    if (!samePage(after.snap.url, address)) {
      return { reached: false, step: 'left', reason: `the click took the page to another address (${after.snap.url})`, ...facts };
    }

    const change = without(diff(start.print, after.print), volatile.parts);
    const newText = contentDiff(start.snap, after.snap, volatile.lines).appeared;
    const changed = change.appeared.length + change.disappeared.length + newText.length > 0;
    const entry = {
      reached: true,
      ...facts,
      changed,
      appeared: capped(change.appeared),
      disappeared: capped(change.disappeared),
      newText: capped(newText),
      key: keyOf(after, prep.reading, volatile),
      ...(await revealedIn(tab.page, after, start, click)),
    };
    // Back where the page loaded, from a state: compared with the page as a
    // first visit read it, in another tab — which is what `prepare`'s volatile
    // parts and lines are there to make fair.
    if (path.length > 0 && changed && backTo(prep.reading, start, after, volatile)) entry.closesParent = path.at(-1).name;
    if (state.close) entry.close = await closeAgain(tab, state.close, { start, reached: after, prep, url });
    return entry;
  } finally {
    await tab.close();
  }
}

// The element a state's selector clicks, told from the others it matches:
// Puppeteer takes the first match and waits for it to be visible, so a
// selector whose first match is hidden fails where a later one would do.
// Read on `reading`, the last snapshot taken: the element's number in it is
// what its steadiest selector is checked against (./selectors.js).
async function describeClick(page, reading, selector) {
  let handles = [];
  try {
    handles = await page.$$(selector);
  } catch {
    // Not a selector: the click says so when it fails.
    return { selector, matches: 0, visible: 0 };
  }
  try {
    const shown = await Promise.all(handles.map((h) => h.isVisible().catch(() => false)));
    const out = { selector, matches: handles.length, visible: shown.filter(Boolean).length };
    if (handles.length === 0) return out;
    out.firstVisible = shown[0];
    // The first match hidden and a later one shown — the desktop link of a
    // menu a phone shows elsewhere — is a click that waits for the hidden one
    // and fails: the one shown is described instead, as `visibleMatch`, for
    // the selector that reaches it.
    const shownAt = shown.indexOf(true);
    if (!shown[0] && shownAt > 0) {
      const visibleMatch = await describeElement(page, reading, handles[shownAt]);
      return { ...out, role: null, name: null, steadiest: null, ...(visibleMatch.role ? { visibleMatch } : {}) };
    }
    return { ...out, ...(await describeElement(page, reading, handles[0])) };
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }
}

// An element as the snapshot lists it: role, name, the steadiest selector
// that finds it alone, and `refused` when the explorer's rules would not have
// touched it. One the snapshot did not list — hidden, or nothing a visitor
// would take for a control — has no steadier selector to offer.
async function describeElement(page, reading, handle) {
  const index = await handle.evaluate((node) => window[Symbol.for('kanso.discover')]?.nodes.indexOf(node) ?? -1);
  const element = reading.snap.elements[index];
  if (!element) return { role: null, name: null, steadiest: null };
  const verdict = reading.verdicts.get(index);
  return {
    role: element.role,
    name: element.name,
    steadiest: await selectorFor(page, element),
    ...(verdict.ok ? {} : { refused: verdict.reason }),
  };
}

// What a click that found nothing to click can say of why, from what its
// selector matched: something, hidden on this screen — a state one screen
// alone has, which `form_factor:` keeps to it — or a hidden first match
// before a shown one, the first being what is clicked.
function whyNotClicked(failure, click) {
  if (failure.step !== 'click' || !click.matches) return '';
  if (click.visible === 0) {
    return `: it matches ${click.matches === 1 ? 'an element' : `${click.matches} elements`}, hidden on this screen — form_factor: keeps a state to the screen that shows it`;
  }
  if (!click.firstVisible) {
    const instead = click.visibleMatch?.steadiest?.selector;
    return `: the first of its ${click.matches} matches is hidden, and the first is the one clicked${instead ? ` — ${instead} finds the one shown` : ''}`;
  }
  return '';
}

// What can be clicked in the state reached that was not there before it,
// one of each family, the way the exploration picks what to click next —
// less the element clicked to get there.
async function revealedIn(page, reading, start, click) {
  const brought = broughtBy(reading, start, click.role == null ? null : click);
  const firsts = families(reading.snap, reading.allowed).filter(({ first }) => brought.has(first));
  const revealed = [];
  for (const { first, size } of firsts.slice(0, MAX_REVEALED)) {
    const { role, name } = reading.snap.elements[first];
    const selector = await selectorFor(page, reading.snap.elements[first]);
    revealed.push({ role, name, selector: selector?.selector ?? null, ...(size > 1 ? { alike: size } : {}) });
  }
  return { revealed, revealedMore: Math.max(0, firsts.length - MAX_REVEALED) };
}

// Whether a state's `close:` closes it: there to be clicked, clicked with
// nothing the guards must stop — an audit clicks it with no guard — and the
// page after it the one the state started from, give or take a trace.
async function closeAgain(tab, selector, { start, reached, prep, url }) {
  const matches = await count(tab.page, selector);
  const blockedBefore = tab.guard.blocked.length;
  try {
    await applyState(tab.page, { click: selector }, { waitMs: WAIT_MS, fromTop: false });
  } catch (err) {
    return { selector, matches, closed: false, reason: firstLine(err) };
  }
  const back = await settle(tab.page);
  const stopped = stoppedBy(tab.guard.blocked.slice(blockedBefore), prep.unprompted).map((b) => describeStopped(b, url));
  if (stopped.length > 0) return { selector, matches, closed: false, reason: `the guards stopped what the click did (${stopped.join(', ')})`, stopped };
  if (!backTo(start, reached, back, prep.volatile)) {
    return { selector, matches, closed: false, reason: 'clicked, and the page is not back where the state started' };
  }
  return { selector, matches, closed: true };
}

async function count(page, selector) {
  try {
    return (await page.$$eval(selector, (nodes) => nodes.length));
  } catch {
    return 0;
  }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0];
}
