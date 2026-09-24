import { inPage } from '../../probes/dom.js';
import { impactOf } from './rules.js';

// What a state leaves behind once it is closed — the page as it was before it
// opened, or not. A transition probe (src/probes/transition.js): the page is
// read, the state opened with a click where the page stands, closed however
// it closes — Escape, its `close:`, a click away from it —, and the page read
// again. What differs is what the state left:
//
//   page-locked           the page no longer scrolls, or takes no click: the
//                         `overflow: hidden`, `position: fixed` or
//                         `pointer-events: none` a dialog puts on <html> or
//                         <body> while it is open, still there
//   overlay-left          something covers the middle of the page and takes
//                         its clicks — a backdrop that stayed
//   page-hidden-left      what a modal dialog hid from assistive technology,
//                         or made inert, stays hidden: a screen reader hears
//                         nothing of the page any more
//   scroll-position-lost  the page is no longer where it was scrolled to
//   expanded-left         the trigger still says `aria-expanded="true"`
//   url-left              the address is not the one the page had
//   close-error           an error, logged or thrown, as the state closed
//   scroll-not-locked     while a modal dialog is open, the page behind it
//                         scrolls under the wheel
//
// A state nothing closes — a list grown longer — leaves nothing to compare,
// and is not judged.

const TEXT = {
  'page-locked': ['The page stays locked after a state closes', 'The styles a dialog puts on <html> or <body> while it is open are still there'],
  'overlay-left': ['Something covers the page after a state closes', 'An overlay left behind takes the clicks meant for the page'],
  'page-hidden-left': ['The page stays hidden from assistive technology after a state closes', 'What a modal dialog hid behind it is not given back'],
  'scroll-position-lost': ['The page loses its scroll position when a state closes', 'The visitor is sent elsewhere on the page'],
  'expanded-left': ['A trigger still says it is expanded after what it opened closed', 'aria-expanded is not set back'],
  'url-left': ['The address changes and stays changed when a state opens and closes', 'Back and a shared link lead somewhere else'],
  'close-error': ['An error is raised as a state closes', 'The code that closes it fails'],
  'scroll-not-locked': ['The page scrolls behind an open modal dialog', 'The wheel moves the page the dialog stands over'],
};

const RULES = Object.keys(TEXT);

// How far the wheel is turned over the page behind a modal dialog, and how far
// the page may drift, in CSS pixels, before it counts as moved or lost.
const WHEEL_PX = 400;
const DRIFT_PX = 40;

export const residues = {
  id: 'residues',
  rules: RULES,
  transitions: true,

  async transition(page, state, tools) {
    const found = [];
    const report = (rule, node, explanation) => found.push(finding(rule, { ...node, explanation }));

    const trigger = await tools.trigger();
    // Scrolled to the trigger, as a visitor reaches it: a page that jumps
    // back to the top as the state closes has somewhere to jump from.
    await inPage(page, scrollToTrigger, state.click);
    const before = await inPage(page, snapshot, state.click);

    const opened = await tools.open({ fromTop: false });
    if (opened.kind === 'modal') {
      const moved = await wheelBehind(page);
      if (moved) report('scroll-not-locked', opened.container, `the page behind it scrolled ${moved} px under the wheel`);
    }

    const errors = [];
    const onError = (err) => errors.push(err?.message ?? String(err));
    const onConsole = (message) => {
      if (message.type() === 'error') errors.push(message.text());
    };
    page.on('pageerror', onError);
    page.on('console', onConsole);
    let closed;
    try {
      ({ closed } = await tools.closeAnyway());
    } finally {
      page.off('pageerror', onError);
      page.off('console', onConsole);
    }
    if (errors.length > 0) report('close-error', trigger, errors[0].split('\n')[0].slice(0, 200));
    if (closed !== true) return found;

    const after = await inPage(page, snapshot, state.click);

    for (const box of ['html', 'body']) {
      const locks = Object.entries(after[box].locks).filter(([key, value]) => value !== before[box].locks[key]);
      if (locks.length > 0) report('page-locked', after[box].element, `${locks.map(([key, value]) => `${key}: ${value}`).join('; ')} on <${box}>, which it did not have before`);
    }
    if (after.cover && after.cover.path !== before.cover?.path) {
      report('overlay-left', after.cover, `covers ${after.cover.share}% of the screen and takes the clicks at its middle`);
    }
    const hiddenBefore = new Set(before.hidden.map(({ path }) => path));
    for (const element of after.hidden.filter(({ path }) => !hiddenBefore.has(path))) {
      report('page-hidden-left', element, `still ${element.how} once the state closed`);
    }
    if (before.scrollY >= DRIFT_PX && Math.abs(after.scrollY - before.scrollY) > DRIFT_PX) {
      report('scroll-position-lost', trigger, `the page was scrolled to ${before.scrollY} px, and is at ${after.scrollY} px once the state closed`);
    }
    if (after.expanded === 'true' && before.expanded !== 'true') {
      report('expanded-left', trigger, 'aria-expanded is still true');
    }
    if (after.href !== before.href) report('url-left', trigger, `the address went from ${before.href} to ${after.href}`);
    return found;
  },
};

function finding(rule, node) {
  const [title, detail] = TEXT[rule];
  return { rule, title, impact: impactOf(rule), count: 1, nodes: [node], detail };
}

// Turns the wheel over the page behind an open modal dialog, away from it, and
// resolves to how far the page moved — 0 when it held, or when there is
// nowhere to turn it or nothing to scroll.
async function wheelBehind(page) {
  const point = await inPage(page, behindPoint);
  if (!point) return 0;
  const y = await page.evaluate('scrollY');
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel({ deltaY: WHEEL_PX });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const moved = Math.round(Math.abs((await page.evaluate('scrollY')) - y));
  // Back where it was, whatever happened: what closes next is judged from
  // there.
  await page.evaluate(`window.scrollTo(0, ${y})`);
  return moved > DRIFT_PX ? moved : 0;
}

// --- in the page ----------------------------------------------------------------

function scrollToTrigger(dom, selector) {
  document.querySelector(selector)?.scrollIntoView({ block: 'center' });
}

// The page, as far as a state can leave anything on it: the styles that lock
// it, what is hidden behind a dialog, what covers its middle, where it is
// scrolled to, its address, and what the trigger says.
function snapshot(dom, triggerSelector) {
  const trigger = document.querySelector(triggerSelector);
  const box = (element) => {
    const css = getComputedStyle(element);
    return {
      element: dom.describe(element),
      locks: {
        overflow: css.overflowY === 'hidden' || css.overflowY === 'clip' ? 'hidden' : 'scrolls',
        position: css.position === 'fixed' ? 'fixed' : 'static',
        'pointer-events': css.pointerEvents === 'none' ? 'none' : 'auto',
      },
    };
  };

  const hidden = [...document.body.children]
    .filter((el) => !['script', 'style', 'template', 'link', 'noscript'].includes(el.localName))
    .filter((el) => el.getAttribute('aria-hidden') === 'true' || el.inert)
    .map((el) => ({ ...dom.describe(el), how: el.inert ? 'inert' : 'aria-hidden' }));

  // What takes a click at the middle of the screen, when it is positioned over
  // the page and covers half of it or more.
  let cover = null;
  const area = innerWidth * innerHeight;
  for (let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2); el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    if (!['fixed', 'absolute'].includes(getComputedStyle(el).position)) continue;
    const rect = el.getBoundingClientRect();
    const visible = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
    if (visible >= area / 2) {
      cover = { ...dom.describe(el), share: Math.round((visible / area) * 100) };
      break;
    }
  }

  return {
    html: box(document.documentElement),
    body: box(document.body),
    hidden,
    cover,
    scrollY: Math.round(scrollY),
    href: location.href,
    expanded: trigger?.getAttribute('aria-expanded') ?? null,
  };
}

// A point over the page behind an open modal dialog: away from the dialog, on
// whatever covers the rest — a backdrop — or on the page itself. Null when the
// page cannot scroll, or the dialog fills the screen.
function behindPoint() {
  const { container } = window[Symbol.for('kanso.transition')] ?? {};
  if (!container || document.documentElement.scrollHeight <= innerHeight + 40) return null;
  const inset = 8;
  const points = [[innerWidth / 2, inset], [inset, innerHeight / 2], [innerWidth - inset, innerHeight / 2], [innerWidth / 2, innerHeight - inset]];
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (hit && !container.contains(hit)) return { x, y };
  }
  return null;
}
