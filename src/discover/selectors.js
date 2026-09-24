// A selector for an element the snapshot read, one that finds it again in the
// next load of the page — which is what a `states:` entry replays
// (src/probes/states.js). Every candidate is tried in the live page, and kept
// only when it matches that element and nothing else.
//
// Plain CSS, and nothing else: a state's selectors are read inside the page as
// well as by Puppeteer — the transition probes look for the trigger with
// `document.querySelector` — so none of Puppeteer's own selectors, however
// steady `::-p-aria()` would be.
//
// The order is how well each survives a change to the page:
//
//   test id       — written for tests, kept on purpose
//   id            — unless it looks generated (./snapshot.js keeps it out then)
//   aria-label    — the name a screen reader is given, with the tag
//   aria-controls — what it opens, when that has an id worth the name
//   href          — a link to a place on the page
//   title         — the tooltip, with the tag
//   css           — the path from the nearest stable id: the last resort

export async function selectorFor(page, element) {
  for (const { kind, selector } of candidates(element)) {
    if (await pointsAt(page, selector, element.index)) return { kind, selector };
  }
  return null;
}

function candidates({ tag, testId, id, ariaLabel, controls, rawHref, title, cssPath }) {
  const out = [];
  if (testId && quotable(testId)) {
    for (const attr of ['data-testid', 'data-test', 'data-cy']) out.push({ kind: 'test-id', selector: `[${attr}=${quote(testId)}]` });
  }
  if (id) out.push({ kind: 'id', selector: `#${cssEscape(id)}` });
  if (ariaLabel && quotable(ariaLabel)) out.push({ kind: 'aria-label', selector: `${tag}[aria-label=${quote(ariaLabel)}]` });
  if (controls) out.push({ kind: 'aria-controls', selector: `${tag}[aria-controls=${quote(controls)}]` });
  if (tag === 'a' && rawHref?.startsWith('#') && quotable(rawHref)) out.push({ kind: 'href', selector: `a[href=${quote(rawHref)}]` });
  if (title && quotable(title)) out.push({ kind: 'title', selector: `${tag}[title=${quote(title)}]` });
  if (cssPath) out.push({ kind: 'css', selector: cssPath });
  return out;
}

// An attribute value short enough to read, on one line.
function quotable(value) {
  return value.length <= 80 && !/[\n\r\\]/.test(value);
}

// A CSS string: double quotes, the ones inside escaped.
function quote(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// CSS.escape, for an id the page already vouched for (./snapshot.js).
function cssEscape(id) {
  return /^[A-Za-z_][\w-]*$/.test(id) ? id : id.replace(/[^\w-]/g, (c) => `\\${c}`);
}

async function pointsAt(page, selector, index) {
  let handles = [];
  try {
    handles = await page.$$(selector);
    if (handles.length !== 1) return false;
    return await handles[0].evaluate((node, i) => window[Symbol.for('kanso.discover')]?.nodes[i] === node, index);
  } catch {
    return false;
  } finally {
    await Promise.all(handles.map((h) => h.dispose().catch(() => {})));
  }
}
