import { SCREENS, viewport } from './screens.js';

// What the probes, the states and discover do with a page, on top of
// Playwright: a page on one of Kanso's screens, the network going quiet, and
// a state's selectors found the way the page itself finds them.

// A page of its own, in a browser context of its own — a first visit — on
// the form factor's screen with its user agent (./screens.js), unless
// `viewport` changes the screen and `media` emulates media features
// (Playwright's names: `{ reducedMotion: 'reduce' }`). Resolves to
// { context, page, session, screen }: `session` a DevTools session on the
// page, `screen` the viewport it was given.
//
// Scrollbars are laid over the page, as on a phone or a Mac: a classic one
// would take 15 px off the width a probe asked for.
export async function newPage(browser, formFactor, { viewport: override, media } = {}) {
  const screen = { ...viewport(formFactor), ...override };
  const context = await browser.newContext({
    viewport: { width: screen.width, height: screen.height },
    deviceScaleFactor: screen.deviceScaleFactor,
    isMobile: screen.isMobile,
    hasTouch: screen.hasTouch,
    userAgent: SCREENS[formFactor].userAgent,
    ...media,
  });
  try {
    const page = await context.newPage();
    watchNetwork(page);
    const session = await context.newCDPSession(page);
    await session.send('Emulation.setScrollbarsHidden', { hidden: true });
    return { context, page, session, screen };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

// A DevTools session on `page`, for what only Chrome does: the CPU slowed,
// the garbage collected, the DOM counted.
export function devtools(page) {
  return page.context().newCDPSession(page);
}

// --- the network ------------------------------------------------------------

const traffic = new WeakMap();

// Counts what `page` has in flight. A request redirected finishes, and the
// next one starts; one stopped fails.
function watchNetwork(page) {
  if (traffic.has(page)) return;
  const state = { inFlight: 0, since: Date.now() };
  traffic.set(page, state);
  page.on('request', () => {
    state.inFlight += 1;
    state.since = Date.now();
  });
  const done = () => {
    state.inFlight = Math.max(0, state.inFlight - 1);
    state.since = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
}

// Resolves to true once no request has been in flight for `idleMs`, counted
// from the call at the earliest, to false when `timeoutMs` went by first — a
// page that polls never goes quiet. Never rejects. A page quiet long before
// the call is still given `idleMs`: what a click just did — a frame to paint,
// the timing of the interaction it reports — is given that time too.
export async function networkIdle(page, { idleMs = 500, timeoutMs }) {
  watchNetwork(page);
  const state = traffic.get(page);
  const called = Date.now();
  const deadline = called + timeoutMs;
  for (;;) {
    const now = Date.now();
    if (state.inFlight === 0 && now - Math.max(state.since, called) >= idleMs) return true;
    if (now >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, deadline - now)));
  }
}

// --- selectors ----------------------------------------------------------------

// A state's selectors are plain CSS, read as the page reads them —
// `document.querySelector`, which the probes run inside the page use too
// (src/probes/transition.js) — and not through Playwright's own engine, which
// looks into shadow roots and reads some strings as something else than CSS.
// The first match is the element, as it is for the page. A string that is no
// selector rejects, with the page's own words for it.

// The first element `selector` matches, or null.
export async function find(page, selector) {
  const handle = await page.evaluateHandle((s) => document.querySelector(s), selector);
  const element = handle.asElement();
  if (!element) await handle.dispose();
  return element;
}

// Every element `selector` matches, in page order.
export async function findAll(page, selector) {
  const list = await page.evaluateHandle((s) => [...document.querySelectorAll(s)], selector);
  try {
    const items = await list.getProperties();
    return [...items.values()].map((item) => item.asElement()).filter(Boolean);
  } finally {
    await list.dispose();
  }
}

// How many elements `selector` matches.
export function count(page, selector) {
  return page.evaluate((s) => document.querySelectorAll(s).length, selector);
}

// The first element `selector` matches, once there is one — and, with
// `visible`, once it shows: a box of some size, and not `visibility: hidden`.
// Rejects with a TimeoutError once `timeout` ms went by.
export async function waitForElement(page, selector, { visible = false, timeout }) {
  const handle = await page.waitForFunction(({ selector: s, visible: v }) => {
    const element = document.querySelector(s);
    if (!element || !v) return element;
    const { width, height } = element.getBoundingClientRect();
    const { visibility } = getComputedStyle(element);
    return width > 0 && height > 0 && visibility !== 'hidden' && visibility !== 'collapse' ? element : null;
  }, { selector, visible }, { timeout });
  return handle.asElement();
}

// Clicks `element` where it is, as a visitor's pointer would — scrolled into
// view, at its middle — without waiting for it to be uncovered, still or
// enabled: what the click lands on is the page's business, and a state whose
// trigger sits under a banner is clicked as a visitor would click it.
export function click(element) {
  return element.click({ force: true });
}
