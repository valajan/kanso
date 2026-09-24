import { inPage } from './dom.js';
import { applyState } from './states.js';

// What a probe that checks the way into and out of a state is handed — a probe
// that says `transitions: true` (src/probes/index.js). A state is not only
// what the page shows once it is open: it is a click, what happens to focus
// when it opens, what is left when it closes. The runner brings a fresh page
// to the state this one starts from; these open it, tell whether it is open, close
// it, and say where focus is — the moves every such check makes, whatever it
// checks. Each is logged, so a journal shows the transition as it went — the
// opening and the closing with a frame of the page as they left it.
//
// Whether a state is open is read from what the configuration says of it, and
// nothing else: its `wait_for` when it has one, else its trigger's
// `aria-expanded`. A state with neither cannot be told open from closed, and
// says so — `null` — rather than guess.
//
// What opened is read from the page, never guessed either: a modal dialog
// that was not showing before — `dialog:modal`, `aria-modal="true"`, or a
// dialog with the rest of the page hidden from assistive technology or made
// inert behind it, which is how Radix, Reka UI and their kin make one modal —,
// a menu or a listbox that was not, or the element the trigger's
// `aria-controls` names. `open` says which — `kind`: 'modal', 'menu',
// 'disclosure' or 'other' — and keeps it in the page, with the trigger, for
// what a probe then runs there: `window[Symbol.for('kanso.transition')]`.

// How long a key press is given to open a state before the next is tried, and
// a close to show. A keyboard user waits no longer.
const KEY_WAIT_MS = 2_000;
// After a state opens or closes: the requests it makes, the transition it
// plays, the focus a script moves once it is done. At least IDLE_MS go by.
const SETTLE_MS = 3_000;
const IDLE_MS = 500;

export function transitionTools(page, state, { waitMs, log }) {
  const settle = () => page.waitForNetworkIdle({ idleTime: IDLE_MS, timeout: SETTLE_MS }).catch(() => {});

  const trigger = async () => page.waitForSelector(state.click, { visible: true, timeout: waitMs })
    .catch(() => {
      throw new Error(`nothing visible to click at ${state.click}`);
    });

  // true, false, or null when nothing says.
  const isOpen = async () => {
    if (state.waitFor) return (await page.$(state.waitFor)) != null;
    const expanded = await page.$eval(state.click, (el) => el.getAttribute('aria-expanded')).catch(() => null);
    return expanded == null ? null : expanded === 'true';
  };

  // Resolves to true once the state shows as `open` (or closed), false when it
  // did not within `ms`, null when nothing says.
  const becomes = async (open, ms) => {
    const now = await isOpen();
    if (now === null) return null;
    if (now === open) return true;
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      if ((await isOpen()) === open) return true;
    }
    return false;
  };

  return {
    // Opens the state. `by: 'click'` as a mouse would, and as `states:` is
    // replayed: it throws when the state does not open, since what follows
    // would check nothing. `by: 'keyboard'` as a keyboard user would: focus
    // the trigger, press Enter, then Space — and says what happened rather
    // than throw, since a trigger no key opens is a finding, not a fault:
    // { opened: true | false | null, key, focusable }.
    //
    // Either way, it also says what opened: { kind, container }, the
    // container described as findings describe an element, or null. The page
    // is scrolled back to the top first, as a visitor who just arrived would
    // find it, unless `fromTop: false`.
    async open({ by = 'click', fromTop = true } = {}) {
      const started = Date.now();
      await inPage(page, beforeOpenInPage);
      if (by === 'click') {
        await applyState(page, state, { waitMs, fromTop });
        const opened = await inPage(page, whatOpenedInPage, state.click, state.waitFor ?? null);
        await log.shot(page, 'open', { by, opened: true, what: opened.kind, ms: Date.now() - started });
        return { opened: true, ...opened };
      }

      const target = await trigger();
      if (fromTop) await page.evaluate('window.scrollTo(0, 0)');
      const focusable = await target.evaluate((el) => {
        el.focus();
        let active = document.activeElement;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
        return active === el || el.contains(active);
      });
      await target.dispose();
      let result = { opened: false, key: null, focusable };
      if (focusable) {
        for (const key of ['Enter', 'Space']) {
          await page.keyboard.press(key);
          const opened = await becomes(true, KEY_WAIT_MS);
          if (opened !== false) {
            result = { opened, key, focusable };
            break;
          }
        }
      }
      await settle();
      const opened = await inPage(page, whatOpenedInPage, state.click, state.waitFor ?? null);
      await log.shot(page, 'open', { by, ...result, what: opened.kind, ms: Date.now() - started });
      return { ...result, ...opened };
    },

    isOpen,

    // Closes the state: `by: 'escape'`; `by: 'close'` — a click on the
    // `close:` the state declares; or `by: 'outside'` — a click on the page
    // away from what opened and from its trigger, as one dismisses a menu or
    // a popover. Resolves to { closed: true | false | null }, null when
    // nothing says whether it is open, no close was declared, or nothing is
    // known of what opened to click away from.
    async close({ by = 'escape' } = {}) {
      const started = Date.now();
      if (by === 'close' && !state.close) {
        log.log('close', { by, closed: null, reason: 'no close: declared' });
        return { closed: null };
      }
      if (by === 'outside') {
        const point = await inPage(page, outsidePointInPage);
        if (!point) {
          log.log('close', { by, closed: null, reason: 'no point outside what opened' });
          return { closed: null };
        }
        await page.mouse.click(point.x, point.y);
      } else if (by === 'escape') await page.keyboard.press('Escape');
      else await page.click(state.close);
      const closed = await becomes(false, KEY_WAIT_MS);
      await settle();
      await log.shot(page, 'close', { by, closed, ms: Date.now() - started });
      return { closed };
    },

    // Closes the state however it closes: Escape, then its declared `close:`,
    // then a click away from it. Resolves to { closed, by } — by the way that
    // closed it, or the last one tried.
    async closeAnyway() {
      let result = { closed: null, by: null };
      for (const by of ['escape', 'close', 'outside']) {
        if (by === 'close' && !state.close) continue;
        const { closed } = await this.close({ by });
        result = { closed, by };
        if (closed !== false) break;
      }
      return result;
    },

    // Where focus is, down through shadow roots: the element as findings
    // describe one (src/probes/dom.js), with its box, or null when it is
    // nowhere — on the body, which is where a browser leaves it when the
    // element that had it goes. Logged as `why`.
    async focused(why) {
      const where = await inPage(page, focusedInPage);
      log.log('focus', { why, ...(where ?? { lost: true }) });
      return where;
    },

    // The element that opens the state, described the same way — what focus
    // goes back to when it closes.
    async trigger() {
      const target = await trigger();
      await target.dispose();
      return inPage(page, triggerInPage, state.click);
    },
  };
}

// --- in the page ----------------------------------------------------------------

// What shows before the state opens, to tell what opened from what was there.
function beforeOpenInPage() {
  const shows = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0);
  const popups = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
  window[Symbol.for('kanso.transition')] = { before: [...document.querySelectorAll(popups)].filter(shows) };
}

// What the state opened: { kind, container }, kept in the page with the
// trigger. Past the three kinds, what `wait_for` names — when it is not the
// trigger itself — is what opened, for a click away from it.
function whatOpenedInPage(dom, triggerSelector, waitFor) {
  const store = window[Symbol.for('kanso.transition')];
  const shows = (el) => (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0);
  const fresh = (el) => !store.before.includes(el) && shows(el);
  const trigger = document.querySelector(triggerSelector);

  // Everything under <body> but what holds the dialog is hidden from
  // assistive technology, or inert — and some of it shows.
  const behindHidden = (dialog) => {
    const behind = [...document.body.children].filter((el) => !['script', 'style', 'template', 'link', 'noscript'].includes(el.localName) && !el.contains(dialog));
    const hidden = (el) => el.getAttribute('aria-hidden') === 'true' || el.inert;
    return behind.some((el) => shows(el) && hidden(el)) && behind.every((el) => hidden(el) || !shows(el));
  };
  const modal = (el) => el.matches('dialog:modal') || el.getAttribute('aria-modal') === 'true' || behindHidden(el);

  let kind = 'other';
  let container = [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]')].find((el) => fresh(el) && modal(el));
  if (container) kind = 'modal';
  else if ((container = [...document.querySelectorAll('[role="menu"], [role="listbox"]')].find(fresh))) kind = 'menu';
  else {
    const id = trigger?.getAttribute('aria-controls')?.trim().split(/\s+/)[0];
    const controlled = id ? document.getElementById(id) : null;
    if (controlled && shows(controlled)) {
      kind = 'disclosure';
      container = controlled;
    } else {
      const named = waitFor ? document.querySelector(waitFor) : null;
      container = named && named !== trigger && !named.contains(trigger) && shows(named) ? named : null;
    }
  }
  store.trigger = trigger;
  store.container = container ?? null;
  return { kind, container: container ? dom.describe(container) : null };
}

// A point of the viewport outside what opened and its trigger, where a click
// lands on the page itself — or null when none is found, or nothing is known
// of what opened. Corners first, then the middle of each edge: where a
// visitor clicks to dismiss.
function outsidePointInPage() {
  const { container, trigger } = window[Symbol.for('kanso.transition')] ?? {};
  if (!container) return null;
  const inset = 8;
  const w = innerWidth;
  const h = innerHeight;
  const points = [[inset, inset], [w - inset, inset], [inset, h - inset], [w - inset, h - inset], [w / 2, inset], [w / 2, h - inset], [inset, h / 2], [w - inset, h / 2]];
  for (const [x, y] of points) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || container.contains(hit) || hit.contains(container) || trigger?.contains(hit)) continue;
    return { x, y };
  }
  return null;
}

// The focused element, or null when focus is on the body or nowhere. A frame
// that has focus is the frame, to this document.
function focusedInPage(dom) {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element || element === document.body || element === document.documentElement) return null;
  const { x, y, width, height } = element.getBoundingClientRect();
  return { ...dom.describe(element), rect: { x, y, width, height } };
}

function triggerInPage(dom, selector) {
  return dom.describe(document.querySelector(selector));
}
