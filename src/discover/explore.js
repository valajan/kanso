import { createHash } from 'node:crypto';

import { applyState } from '../probes/states.js';
import { contentDiff, diff, part as partOf } from './fingerprint.js';
import { load, openPage, prepare, settle } from './page.js';
import { selectorFor } from './selectors.js';

// The exploration of one page on one screen: every element the guards allow
// clicked, from a first visit, then every element each state that opened
// brought clicked in turn, down to `maxDepth` clicks — no model choosing.
// Clicking everything two deep finds the states a page has in about thirty
// seconds, for a page offers only five to thirty elements once the guards
// have had their say.
//
// A state is a node, reached from a first visit by replaying its path, one
// click at a time, as a `states:` entry is replayed (src/probes/states.js).
// The clicks are taken breadth first: every click from the page as it loads
// before any click inside what one of them opened, so that a budget running
// out leaves the deeper states unfound rather than whole parts of the page.
//
// What tells a new state from one already seen is a fingerprint, computed by
// code (./fingerprint.js): the controls a visitor can see, by role, name and
// ARIA state, the dialogs open, and the text that appeared — less what
// changes on its own, which two first visits and a scroll through the page
// show (./page.js, `prepare`).

const CLICK_WAIT_MS = 5_000;

export const DEFAULTS = { maxDepth: 2, maxClicks: 60, timeoutMs: 180_000 };

// Resolves to { nodes, clicks, stable, leftInQueue, outOfTime }. `nodes` are
// the states found, parents before children, each as
// { id, parent, click, waitFor, role, name, depth } — `parent` null for one
// reached from the page as it loads; `clicks`, every click made and what it
// came to. `onClick` hears of each as it lands.
export async function explore(browser, formFactor, url, { maxDepth = DEFAULTS.maxDepth, maxClicks = DEFAULTS.maxClicks, timeoutMs = DEFAULTS.timeoutMs, onClick = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  const prep = await prepare(browser, formFactor, url);
  const { volatile } = prep;
  const rootReading = prep.reading;

  const root = { id: 0, depth: 0, path: [], reading: rootReading };
  const nodes = [root];
  const seen = new Set([keyOf(rootReading, rootReading, volatile)]);
  const queue = [];
  const clicks = [];

  const enqueue = (node, candidates) => {
    if (node.depth >= maxDepth) return;
    for (const element of candidates) queue.push({ node, element });
  };
  enqueue(root, candidatesOf(root, rootReading, prep.selectorsOf, null));

  while (queue.length > 0 && clicks.length < maxClicks && Date.now() < deadline) {
    const { node: parent, element } = queue.shift();
    const path = [...parent.path, element];
    const click = { from: parent.id, depth: path.length, role: element.role, name: element.name, selector: element.selector.selector };

    const tab = await openPage(browser, formFactor);
    try {
      await load(tab, url);
      for (const step of parent.path) {
        await applyState(tab.page, { click: step.selector.selector }, { waitMs: CLICK_WAIT_MS });
        await settle(tab.page);
      }
      const blockedBefore = tab.guard.blocked.length;
      await tab.page.evaluate(markPresent);
      const before = tab.page.url();
      await applyState(tab.page, { click: element.selector.selector }, { waitMs: CLICK_WAIT_MS });
      const after = await settle(tab.page);
      const blocked = tab.guard.blocked.slice(blockedBefore);
      // A click the guards stopped from leaving the page reaches nothing a
      // state could be made of — nor does one that took the page to another
      // address without loading it, the way a single-page app changes route:
      // what it shows is another page, which is not replayed from this one.
      // Compared with where the page stood just before the click, not with
      // the address it was loaded from: an app that sends `/` on to `/home`
      // as it starts has not left anything when a menu opens on `/home`.
      const left = blocked.some((b) => b.kind === 'navigation' || b.kind === 'window') || !samePage(after.snap.url, before);

      const fromParent = without(diff(parent.reading.print, after.print), volatile.parts);
      const newText = contentDiff(parent.reading.snap, after.snap, volatile.lines).appeared;
      const key = keyOf(after, rootReading, volatile);

      if (left) click.outcome = 'left';
      else if (fromParent.appeared.length === 0 && fromParent.disappeared.length === 0 && newText.length === 0) click.outcome = 'no-change';
      else if (seen.has(key)) click.outcome = 'repeat';
      else {
        seen.add(key);
        const node = { id: nodes.length, parent: parent.id, depth: path.length, path, reading: after };
        node.waitFor = await waitForOf(tab.page, after, parent.reading, fromParent.appeared);
        nodes.push(node);
        click.outcome = 'new-state';
        click.node = node.id;
        if (node.depth < maxDepth) {
          const selectorsOf = new Map();
          for (const index of after.allowed) selectorsOf.set(index, await selectorFor(tab.page, after.snap.elements[index]));
          enqueue(node, candidatesOf(node, after, selectorsOf, parent));
        }
      }
      if (blocked.length) click.blocked = blocked;
    } catch (err) {
      click.outcome = 'error';
      click.error = err.message.split('\n')[0];
    } finally {
      await tab.close();
    }
    clicks.push(click);
    onClick(click);
  }

  return {
    nodes: nodes.slice(1).map(({ id, parent, depth, path, waitFor }) => {
      const { role, name, selector } = path.at(-1);
      return { id, parent: parent === 0 ? null : parent, click: selector.selector, waitFor, role, name, depth };
    }),
    clicks,
    stable: prep.stable,
    leftInQueue: queue.length,
    outOfTime: queue.length > 0 && clicks.length < maxClicks,
  };
}

// The candidates a state offers: what the guards allow and a selector finds,
// one per family — and, past the page as it loads, only what the state
// brought: the menu's items, not the page behind it again.
function candidatesOf(node, reading, selectorsOf, parent) {
  const before = parent ? new Set(parent.reading.print.parts) : null;
  const clicked = node.path.at(-1);
  return families(reading.snap, reading.allowed)
    .map(({ first }) => reading.snap.elements[first])
    .filter((e) => selectorsOf.get(e.index))
    .filter((e) => !before || !before.has(partOf(e)))
    .filter((e) => !clicked || !(e.role === clicked.role && e.name === clicked.name))
    .map((e) => ({ ...e, selector: selectorsOf.get(e.index) }));
}

// The allowed elements grouped by what they are, in page order of their first
// member, each family tried once, by its first: thirty "Save" buttons on
// thirty cards are one thing to try, not thirty — and so are thirty "Add
// this one" buttons, each named after its card, or the questions of an FAQ.
//
// An element is one of a family when it sits at the same place in a repeated
// container — the same path to it, whichever list item or card it is in —
// with the same role, ARIA state and region, whatever it is called. Elements
// side by side are too, once there are SET of them alike — a row of colour
// filters, of page numbers — but not fewer: a toolbar's three buttons, a
// list of four tabs, are each their own. And an element with an id worth the
// name is its own, whatever its neighbours.
//
// What is lost is what a single member hides behind it and the first does
// not: an accordion's third answer is not opened. What is saved is a page of
// products explored as one, rather than for minutes as a hundred.
const SET = 5;

export function families(snap, allowed) {
  const elements = snap.elements.filter((e) => allowed.has(e.index));
  const keyOf = (e, loose) => JSON.stringify([e.inferred ? 'clickable' : e.role, shape(e, loose), e.states, e.region]);
  const alike = new Map();
  for (const e of elements) alike.set(keyOf(e, true), (alike.get(keyOf(e, true)) ?? 0) + 1);

  const byKey = new Map();
  for (const e of elements) {
    const key = keyOf(e, alike.get(keyOf(e, true)) >= SET);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e.index);
  }
  return [...byKey.values()].map((members) => ({ first: members[0], members, size: members.length }));
}

// What says the state has been reached, for a `states:` entry's `wait_for` —
// something that is not already true before the click: a control the state
// brought, else one whose ARIA state it changed, with that state in the
// selector. None when it brought only text: the replay then waits for the
// network to go quiet, as src/probes/states.js does.
async function waitForOf(page, reading, before, parts) {
  const wanted = new Set(parts);
  const existed = new Set(before.snap.elements.map((e) => `${e.role}|${e.name}`));
  const changed = reading.snap.elements.filter((e) => wanted.has(partOf(e)));
  for (const e of changed.filter((e) => !existed.has(`${e.role}|${e.name}`))) {
    // One that was in the page all along, hidden — a menu's links under
    // `display: none` — is matched by its selector before the click as well
    // as after: waiting for it waits for nothing.
    if (await page.evaluate(wasPresent, e.index)) continue;
    const sel = await selectorFor(page, e);
    if (sel) return sel.selector;
  }
  // A tab now selected, a disclosure now expanded: the same element, in its
  // new state — which only a CSS selector can say.
  for (const e of changed.filter((e) => existed.has(`${e.role}|${e.name}`))) {
    // A checkbox's state is its property: no attribute to select on.
    if (e.tag === 'input') continue;
    const sel = await selectorFor(page, e);
    // A <summary>'s is its <details>' `open`, which a selector can say when
    // the path to the summary goes through the details.
    if (e.tag === 'summary') {
      const details = sel?.kind === 'css' && sel.selector.match(/^(.*details[^>]*?)\s*>\s*summary$/);
      if (details && e.states.expanded === 'true') return `${details[1]}[open]`;
      continue;
    }
    // Only an element found by what does not flip with its state: an
    // aria-label reading "Open menu" may read "Close menu" once it is open.
    if (!sel || ['aria-label', 'title'].includes(sel.kind)) continue;
    const flipped = Object.entries(e.states).filter(([k]) => ['expanded', 'selected', 'pressed', 'checked', 'current'].includes(k));
    if (flipped.length) return sel.selector + flipped.map(([k, v]) => `[aria-${k}="${v}"]`).join('');
  }
  return null;
}

// Run in the page: every element it holds before a click, seen or not, kept
// to tell what the click added from what it only showed.
function markPresent() {
  window[Symbol.for('kanso.discover.present')] = new WeakSet(document.querySelectorAll('*'));
}

// Run in the page: whether the element the last snapshot numbered `index`
// (./snapshot.js) was already there before the click.
function wasPresent(index) {
  const node = window[Symbol.for('kanso.discover')]?.nodes[index];
  return !!node && !!window[Symbol.for('kanso.discover.present')]?.has(node);
}

// Where an element sits, with the places in the repeated containers above it
// left out: `ul > li:nth-of-type(7) > button` is `ul > li > button`, and
// `div > button:nth-of-type(2)` stays itself — a sibling is not an instance —
// unless `loose`, which leaves its own place out too. With no path
// (./snapshot.js), its name: it is its own.
function shape({ cssPath, name }, loose = false) {
  if (!cssPath) return `name:${name}`;
  const parts = cssPath.split(' > ');
  const strip = (part) => part.replace(/:nth-of-type\(\d+\)$/, '');
  return [...parts.slice(0, -1).map(strip), loose ? strip(parts.at(-1)) : parts.at(-1)].join(' > ');
}

function without({ appeared, disappeared }, ignored) {
  return { appeared: appeared.filter((p) => !ignored.has(p)), disappeared: disappeared.filter((p) => !ignored.has(p)) };
}

// The same document: a fragment is still the page, another path or query is
// not.
function samePage(a, b) {
  try {
    const [x, y] = [new URL(a), new URL(b)];
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch {
    return a === b;
  }
}

// A state: its controls, and the text it shows that the page as it loads does
// not, less what changes on its own.
function keyOf(reading, rootReading, volatile) {
  const text = contentDiff(rootReading.snap, reading.snap, volatile.lines).appeared;
  const parts = reading.print.parts.filter((p) => !volatile.parts.has(p));
  return createHash('sha1').update(parts.join('\n')).update('\0').update([...text].sort().join('\n')).digest('hex').slice(0, 12);
}
