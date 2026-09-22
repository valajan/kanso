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
//       click: "#signup"
//
// At the root, like `runs:`, and for the same reason: a state is a way through
// the page, and what the page looks like there concerns every module, not one.
// A check says whether it goes through them (src/probes/index.js).
//
// The states are cumulative: each one is reached from the one before it, in
// the same page, as a visitor would — the signup form above is the one a
// visitor finds with the menu open.
//
// A state is its name, the element clicked to reach it, and, optionally, what
// says it has been reached. Both are CSS selectors. A state missing either of
// the first two is a mistake in the file, and fails the configuration rather
// than being skipped: a state quietly left out is a part of the page quietly
// left unchecked.

// A name is what a finding reached there carries (`at`), and what its level
// is keyed by: `color-contrast@menu`. Kept to what reads well in both.
const NAME = /^[A-Za-z0-9][\w-]*$/;

export class InvalidStates extends Error {}

// The declared states, as { name, click, waitFor }, in order. Nothing declared
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

    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new InvalidStates(`${where} needs a name — letters, digits, - and _`);
    }
    if (names.has(name)) throw new InvalidStates(`${where}: the name ${name} is taken by an earlier state`);
    names.add(name);
    if (typeof click !== 'string' || click.trim() === '') {
      throw new InvalidStates(`${where} (${name}) needs a click: the selector of the element that opens it`);
    }
    if (waitFor != null && (typeof waitFor !== 'string' || waitFor.trim() === '')) {
      throw new InvalidStates(`${where} (${name}): wait_for must be a selector`);
    }

    return { name, click, ...(waitFor != null ? { waitFor } : {}) };
  });
}
