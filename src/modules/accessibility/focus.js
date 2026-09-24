import { inPage } from '../../probes/dom.js';
import { impactOf } from './rules.js';

// What happens to keyboard focus on the way into and out of each declared
// state — what axe, reading one DOM, and the keyboard walk, reading one state,
// both miss. A transition probe (src/probes/transition.js): the state is
// opened as a keyboard user opens it, focus is read, the state is closed,
// focus is read again.
//
//   keyboard-inoperable   the trigger takes no focus, or neither Enter nor
//                         Space opens the state — a click does (WCAG 2.1.1)
//   focus-lost            focus was on the page, and the state opening or
//                         closing left it nowhere (WCAG 2.4.3)
//   focus-not-moved       a modal dialog opened, and focus stayed outside it
//                         (WCAG 2.4.3)
//   focus-escapes-modal   Tab, inside an open modal dialog, reaches the page
//                         behind it (WCAG 2.4.3)
//   escape-not-closing    Escape leaves a modal dialog or a menu open (APG;
//                         WCAG 2.1.2 for a dialog nothing else closes)
//   focus-not-returned    a modal dialog or a menu closed, and focus did not go
//                         back to what opened it (WCAG 2.4.3, APG)
//   revealed-unreachable  a disclosure opened, and the next Tab from its
//                         trigger does not go into what it revealed — content
//                         put at the end of the page, a portal (WCAG 2.4.3)
//
// What opened — a modal dialog, a menu or listbox, a disclosure — is what the
// transition tools read from the page (src/probes/transition.js). What is
// none of those — a list grown longer, a panel with no name — is checked for
// focus lost, and nothing else asks anything of it.

// How many Tab presses a modal dialog is walked for, looking for the way out.
const MAX_TABS = 25;

const RULES = [
  'keyboard-inoperable', 'focus-lost', 'focus-not-moved', 'focus-escapes-modal',
  'escape-not-closing', 'focus-not-returned', 'revealed-unreachable',
];

const TEXT = {
  'keyboard-inoperable': ['A state opens with a click but not from the keyboard', 'WCAG 2.1.1 Keyboard'],
  'focus-lost': ['Keyboard focus is lost as a state opens or closes', 'WCAG 2.4.3 Focus Order'],
  'focus-not-moved': ['Keyboard focus stays behind an open modal dialog', 'WCAG 2.4.3 Focus Order'],
  'focus-escapes-modal': ['Keyboard focus leaves an open modal dialog for the page behind it', 'WCAG 2.4.3 Focus Order'],
  'escape-not-closing': ['Escape does not close a dialog or a menu', 'ARIA Authoring Practices: dialog and menu keyboard interaction'],
  'focus-not-returned': ['Keyboard focus does not return to what opened a dialog or a menu', 'WCAG 2.4.3 Focus Order'],
  'revealed-unreachable': ['What a disclosure reveals is not next in the keyboard order', 'WCAG 2.4.3 Focus Order'],
};

export const focus = {
  id: 'focus',
  rules: RULES,
  transitions: true,

  async transition(page, state, tools) {
    const found = [];
    const report = (rule, node, explanation) => found.push(finding(rule, { ...node, explanation }));

    const trigger = await tools.trigger();

    // As a keyboard user would; a click when no key can, for the rest.
    const byKey = await tools.open({ by: 'keyboard' });
    if (!byKey.focusable) report('keyboard-inoperable', trigger, 'takes no keyboard focus, and only a click opens what it opens');
    else if (byKey.opened === false) report('keyboard-inoperable', trigger, 'neither Enter nor Space opens what a click opens');
    const opened = byKey.opened === false ? await tools.open() : byKey;
    const hadFocus = byKey.focusable;

    const popup = opened.kind === 'modal' || opened.kind === 'menu';
    const afterOpen = await tools.focused('opened');

    if (opened.kind === 'modal' && (afterOpen === null || !(await inPage(page, focusInside)))) {
      report('focus-not-moved', opened.container, afterOpen ? `focus stayed on ${afterOpen.selector}` : 'focus went nowhere');
    } else if (afterOpen === null && hadFocus) {
      report('focus-lost', trigger, 'opening what it opens left focus nowhere');
    }

    if (opened.kind === 'modal') {
      // From inside, whoever put it there: whether Tab gets out is a question
      // of its own, not an echo of focus never having gone in.
      await inPage(page, focusIntoContainer);
      const out = await tabOut(page);
      if (out) report('focus-escapes-modal', out, `Tab reached it, behind the open ${opened.container.selector}`);
    }

    if (opened.kind === 'disclosure' && byKey.focusable && (await inPage(page, hasFocusable))) {
      await inPage(page, focusTrigger);
      await page.keyboard.press('Tab');
      if (!(await inPage(page, focusInside))) {
        const next = await tools.focused('next after trigger');
        report('revealed-unreachable', trigger, `the next Tab goes to ${next ? next.selector : 'nothing'}, not into ${opened.container.selector}`);
      }
    }

    // Out again: Escape, else what the state declares closes it.
    let { closed } = await tools.close();
    if (closed === false && popup) report('escape-not-closing', opened.container, 'still open after Escape');
    if (closed !== true && state.close) ({ closed } = await tools.close({ by: 'close' }));
    if (closed !== true) return found;

    const afterClose = await tools.focused('closed');
    if (afterClose === null && (hadFocus || popup)) {
      report('focus-lost', trigger, 'closing what it opened left focus nowhere');
    } else if (popup && afterClose && afterClose.path !== trigger.path && (await inPage(page, triggerShows))) {
      report('focus-not-returned', trigger, `focus went to ${afterClose.selector} when what it opened closed`);
    }
    return found;
  },
};

function finding(rule, node) {
  const [title, detail] = TEXT[rule];
  return { rule, title, impact: impactOf(rule), count: 1, nodes: [node], detail };
}

// Tab through an open modal dialog until focus lands outside it, and resolve
// to where — or to null when it never does: it stays in, or leaves for the
// browser, which is where a modal dialog lets it go.
async function tabOut(page) {
  for (let i = 0; i < MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const out = await inPage(page, focusOutside);
    if (out) return out;
  }
  return null;
}

// --- in the page ----------------------------------------------------------------
//
// Sent as source (src/probes/dom.js). What opened and what opened it, the
// transition tools keep in the page (src/probes/transition.js).

// Whether focus is inside what opened, through shadow roots.
function focusInside() {
  const { container } = window[Symbol.for('kanso.transition')];
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  for (let node = element; node; node = node.parentNode ?? node.host) {
    if (node === container) return true;
  }
  return false;
}

// The focused element when it is on the page but outside what opened, else
// null.
function focusOutside(dom) {
  const { container } = window[Symbol.for('kanso.transition')];
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element || element === document.body || element === document.documentElement) return null;
  for (let node = element; node; node = node.parentNode ?? node.host) {
    if (node === container) return null;
  }
  return dom.describe(element);
}

function hasFocusable() {
  const { container } = window[Symbol.for('kanso.transition')];
  const focusable = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  return [...container.querySelectorAll(focusable)].some((el) => el.checkVisibility?.() ?? el.getClientRects().length > 0);
}

// Focus on the first thing in what opened that takes it, else on what opened
// itself — unless focus is in there already.
function focusIntoContainer() {
  const { container } = window[Symbol.for('kanso.transition')];
  if (container.contains(document.activeElement)) return;
  const focusable = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
  const first = [...container.querySelectorAll(focusable)].find((el) => el.checkVisibility?.() ?? el.getClientRects().length > 0);
  (first ?? container).focus();
}

function focusTrigger() {
  window[Symbol.for('kanso.transition')].trigger.focus();
}

// Whether what opened the state is still there to go back to: a trigger that
// went — a "Load more" gone once it loaded — cannot have focus back.
function triggerShows() {
  const { trigger } = window[Symbol.for('kanso.transition')];
  return Boolean(trigger?.isConnected && (trigger.checkVisibility?.() ?? trigger.getClientRects().length > 0));
}
