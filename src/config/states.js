import { isPlainObject } from './merge.js';

// The states of a page a project declares, beyond the one it loads in: a menu
// opened, a dialog shown — what only a click shows, and what a load alone
// never measures.
//
//   states:
//     - name: menu
//       click: "[aria-label='Menu']"
//       wait_for: "#menu[aria-expanded='true']"
//     - name: signup
//       from: menu
//       click: "#signup"
//       close: "#signup-cancel"
//     - name: settings
//       click: "#settings"
//
// At the root, like `runs:`, and for the same reason: a state is a way through
// the page, and what the page looks like there concerns every module, not one.
// A check says whether it goes through them (src/probes/index.js).
//
// A state is reached from the page as it loads, unless it says it starts
// `from` another — the signup form above is the one a visitor finds with the
// menu open; the settings, the one they find on arriving. The states form a
// tree, then, rather than a chain: a dialog left open by one state does not
// stand in the way of the next, and a state that cannot be reached costs only
// the ones reached through it. `from` names a state declared before it, which
// is what keeps a state from being reached through itself.
//
// A state is its name, the element clicked to reach it, and, optionally, the
// state it starts from, what says it has been reached, and what closes it when
// Escape is not meant to — for a check that goes in and out of it
// (src/probes/transition.js). The last three are CSS selectors. A state
// missing either of the first two is a mistake in the file, and fails the
// configuration rather than being skipped: a state quietly left out is a part
// of the page quietly left unchecked.

// A name is what a finding reached there carries (`at`), and what its level
// is keyed by: `color-contrast@menu`. Kept to what reads well in both.
const NAME = /^[A-Za-z0-9][\w-]*$/;

export class InvalidStates extends Error {}

// The declared states, as { name, click, from, waitFor, close } — each of the
// last three only when declared — in order. Nothing declared
// is no state. Anything the file got wrong throws, naming the state.
export function parseStates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidStates('states: must be a list');

  const names = new Set();
  return value.map((state, i) => {
    const where = `states[${i}]`;
    if (!isPlainObject(state)) throw new InvalidStates(`${where} must be a mapping with a name and a click`);
    const { name, click } = state;
    const waitFor = state.wait_for ?? state.waitFor;
    const { close, from } = state;

    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new InvalidStates(`${where} needs a name — letters, digits, - and _`);
    }
    if (names.has(name)) throw new InvalidStates(`${where}: the name ${name} is taken by an earlier state`);
    if (from != null && (typeof from !== 'string' || !names.has(from))) {
      throw new InvalidStates(`${where} (${name}): from must name a state declared before it`);
    }
    names.add(name);
    if (typeof click !== 'string' || click.trim() === '') {
      throw new InvalidStates(`${where} (${name}) needs a click: the selector of the element that opens it`);
    }
    if (waitFor != null && (typeof waitFor !== 'string' || waitFor.trim() === '')) {
      throw new InvalidStates(`${where} (${name}): wait_for must be a selector`);
    }

    if (close != null && (typeof close !== 'string' || close.trim() === '')) {
      throw new InvalidStates(`${where} (${name}): close must be a selector`);
    }

    return { name, click, ...(from != null ? { from } : {}), ...(waitFor != null ? { waitFor } : {}), ...(close != null ? { close } : {}) };
  });
}

// The states `state` is reached through, from the page as it loads: the one
// it starts from, the one that one starts from, and so on — the first to click
// first. Empty for a state reached from the page itself.
export function pathTo(states, state) {
  const byName = new Map(states.map((s) => [s.name, s]));
  const path = [];
  for (let at = byName.get(state.from); at; at = byName.get(at.from)) path.unshift(at);
  return path;
}

// The states in the order a walk through one page takes them: each followed
// by the ones that start from it, depth first, and siblings in the order they
// are declared. A state is then read while the page is still in the one it
// starts from, and the page is loaded again only to start down another branch
// — never for a chain, which is walked as it is declared.
export function walkOrder(states) {
  const from = (name) => states.filter((s) => (s.from ?? null) === name);
  const visit = (state) => [state, ...from(state.name).flatMap(visit)];
  return from(null).flatMap(visit);
}
