import { diff, fingerprint, volatileLines } from './fingerprint.js';
import { guardPage, verdict, writeKey } from './guards.js';
import { emulate } from './screens.js';
import { selectorFor } from './selectors.js';
import { snapshot } from './snapshot.js';

// How long a loaded page is given to go quiet, as src/probes/index.js does.
const SETTLE_MS = 5_000;
const LOAD_TIMEOUT_MS = 30_000;

// A page of its own, in a browser context of its own, on one of Kanso's two
// screens, guarded for as long as it lives. A fresh context is a first visit:
// no cookie a previous click set — a consent banner dismissed once stays
// dismissed for the whole context, and every reading after it would differ
// from the first by the banner alone.
export async function openPage(browser, formFactor) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await emulate(page, formFactor);
  const guard = await guardPage(page);
  return {
    page,
    guard,
    async close() {
      await guard.dispose();
      await context.close().catch(() => {});
    },
  };
}

// Loads `url`, the one navigation the guard lets through, and waits for the
// page to go quiet.
export async function load({ page, guard }, url) {
  guard.allow(url);
  try {
    await page.goto(url, { waitUntil: 'load', timeout: LOAD_TIMEOUT_MS });
  } finally {
    guard.allow(null);
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
}

// One reading of the page as it stands: the snapshot, what the guards make of
// each element, and the fingerprint. A link is judged from where the page
// stands, which is not always the address it was loaded from: an app that
// sends `/` on to `/home` as it starts is on `/home`, and a link to
// `/home#top` does not leave it.
export async function observe(page) {
  const snap = await snapshot(page);
  const verdicts = new Map(snap.elements.map((e) => [e.index, verdict(e, snap.url)]));
  const allowed = new Set([...verdicts].filter(([, v]) => v.ok).map(([i]) => i));
  return { snap, verdicts, allowed, print: fingerprint(snap) };
}

// How long what a click opens is given to finish appearing, and how often it
// is looked at meanwhile.
const SETTLE_MAX_MS = 3_000;
const SETTLE_STEP_MS = 250;

// A reading taken once the page has stopped changing: two in a row that agree,
// text included. The network going quiet is not enough — a modal whose code
// arrives with the click is drawn after the request that brought it, and a
// reading taken then sees the page as it was before.
export async function settle(page) {
  let last = await observe(page);
  const until = Date.now() + SETTLE_MAX_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, SETTLE_STEP_MS));
    const next = await observe(page);
    if (next.print.key === last.print.key && sameLines(next.snap.lines, last.snap.lines)) return next;
    last = next;
  }
  return last;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// Scrolls through the whole page, a screen at a time, and back to the top: what
// a visitor reading it down would make it render — lazy sections, images,
// lists drawn as they come into view. A click on an element far down scrolls
// to it, and what that renders is not what the click opened.
//
// Resolves to every line of text seen on the way down. Read at each screen,
// not once back at the top: text under `content-visibility: auto` is only
// rendered while near the screen, and is gone from the page's text again once
// scrolled past — while a click far down leaves the page scrolled there.
export async function scrollThrough(page) {
  const lines = await page.evaluate(async () => {
    const seen = new Set();
    const read = () => {
      for (const l of document.body.innerText.split('\n')) {
        const flat = l.replace(/\s+/g, ' ').trim();
        if (flat) seen.add(flat.length > 200 ? flat.slice(0, 199) + '…' : flat);
      }
    };
    const step = innerHeight;
    for (let y = 0; y < document.documentElement.scrollHeight && y < 40 * step; y += step) {
      scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 150));
      read();
    }
    scrollTo(0, 0);
    return [...seen];
  });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: SETTLE_MS }).catch(() => {});
  return lines;
}

// Everything an exploration starts from: the page as a first visit reads it,
// a selector for each element it may click, and what a click is not to be
// judged on — what two first visits disagree on (`drift`, `onTheirOwn`), and
// what scrolling alone renders (`byScrolling`), folded into `volatile` — and
// where the page writes on its own, with nothing clicked (`unprompted`): the
// beacons the guards stop during any click, which are not the click's doing
// (./guards.js, `stoppedBy`).
export async function prepare(browser, formFactor, url) {
  const tab = await openPage(browser, formFactor);
  let reading;
  let selectorsOf;
  try {
    await load(tab, url);
    reading = await observe(tab.page);
    selectorsOf = await selectors(tab.page, reading);
  } finally {
    await tab.close();
  }
  const writes = tab.guard.blocked.filter((b) => b.kind === 'write');

  // The same page visited again, from a context of its own: a fingerprint
  // that moves with nothing clicked would make every click look like a new
  // state. Then read down to the bottom: the text a scroll alone renders is
  // not what a click opened.
  const other = await openPage(browser, formFactor);
  let again;
  let scrolled;
  let seenScrolling;
  try {
    await load(other, url);
    again = await observe(other.page);
    seenScrolling = await scrollThrough(other.page);
    scrolled = await observe(other.page);
  } finally {
    await other.close();
  }
  writes.push(...other.guard.blocked.filter((b) => b.kind === 'write'));
  const drift = diff(reading.print, again.print);
  const onTheirOwn = volatileLines(reading.snap, again.snap);
  const atLoad = new Set(reading.snap.lines);
  const byScrolling = new Set([...volatileLines(reading.snap, scrolled.snap), ...seenScrolling.filter((l) => !atLoad.has(l))]
    .filter((l) => !onTheirOwn.has(l)));
  const scrollDrift = diff(reading.print, scrolled.print);
  return {
    reading,
    selectorsOf,
    drift,
    stable: drift.appeared.length === 0 && drift.disappeared.length === 0,
    onTheirOwn,
    byScrolling,
    unprompted: new Set(writes.map(writeKey)),
    volatile: {
      lines: new Set([...onTheirOwn, ...byScrolling]),
      parts: new Set([...drift.appeared, ...drift.disappeared, ...scrollDrift.appeared, ...scrollDrift.disappeared]),
    },
  };
}

// A selector for every element the guards allow — what a state would be
// replayed with. Must run on the reading it was computed for: the numbering is
// that reading's.
export async function selectors(page, reading) {
  const out = new Map();
  for (const index of reading.allowed) {
    out.set(index, await selectorFor(page, reading.snap.elements[index]));
  }
  return out;
}
