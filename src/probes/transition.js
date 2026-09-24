import { inPage } from './dom.js';
import { applyState } from './states.js';

// What a probe that checks the way into and out of a state is handed — a probe
// that says `transitions: true` (src/probes/index.js). A state is not only
// what the page shows once it is open: it is a click, what happens to focus
// when it opens, what is left when it closes. The runner brings a fresh page
// to the state before this one; these open it, tell whether it is open, close
// it, and say where focus is — the moves every such check makes, whatever it
// checks. Each is logged, so a journal shows the transition as it went.
//
// Whether a state is open is read from what the configuration says of it, and
// nothing else: its `wait_for` when it has one, else its trigger's
// `aria-expanded`. A state with neither cannot be told open from closed, and
// says so — `null` — rather than guess.

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
    async open({ by = 'click' } = {}) {
      const started = Date.now();
      if (by === 'click') {
        await applyState(page, state, { waitMs });
        log.log('open', { by, opened: true, ms: Date.now() - started });
        return { opened: true };
      }

      const target = await trigger();
      await page.evaluate('window.scrollTo(0, 0)');
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
      log.log('open', { by, ...result, ms: Date.now() - started });
      return result;
    },

    isOpen,

    // Closes the state: `by: 'escape'`, or `by: 'close'` — a click on the
    // `close:` the state declares. Resolves to { closed: true | false | null },
    // null when nothing says whether it is open, or no close was declared.
    async close({ by = 'escape' } = {}) {
      const started = Date.now();
      if (by === 'close' && !state.close) {
        log.log('close', { by, closed: null, reason: 'no close: declared' });
        return { closed: null };
      }
      if (by === 'escape') await page.keyboard.press('Escape');
      else await page.click(state.close);
      const closed = await becomes(false, KEY_WAIT_MS);
      await settle();
      log.log('close', { by, closed, ms: Date.now() - started });
      return { closed };
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
