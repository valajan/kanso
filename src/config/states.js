import { isPlainObject } from './merge.js';

// The states of a page, beyond the one it loads in: a menu opened, a dialog
// shown — what only a click shows, and what a load alone never measures.
//
//   states:
//     - name: menu
//       form_factor: mobile
//       click: "[aria-label='Menu']"
//       wait_for: "#menu[aria-expanded='true']"
//       states:
//         - name: signup
//           click: "#signup"
//           close: "#signup-cancel"
//     - name: settings
//       click: "#settings"
//
// At the root, like `runs:`, and for the same reason: a state is a way through
// the page, and what the page looks like there concerns every module, not one.
// A check says whether it goes through them (src/probes/index.js).
//
// Two files say them: the ones `kanso discover` found, in the file it writes
// whole (.kanso/states.yml), and the ones a project writes by hand, in its
// .kanso.yml — what no click-through finds. `combineStates` makes one list of
// them.
//
// The states form a tree. A state is reached from the page as it loads, and
// the states listed under it from it — the signup form above is the one a
// visitor finds with the menu open; the settings, the one they find on
// arriving. A dialog left open by one state does not stand in the way of the
// next, and a state that cannot be reached costs only the ones under it.
//
// A state is on both screens Kanso audits unless it says `form_factor:` — a
// drawer only a phone's layout has — and the states under it are on that
// screen too.
//
// A state is its name, the element clicked to reach it, and, optionally, what
// says it has been reached, and what closes it when Escape does not — for a
// check that goes in and out of it (src/probes/transition.js), which always
// tries Escape first: a `close:` is what is clicked next, never what spares a
// dialog Escape leaves open its finding. All three
// are CSS selectors. A state missing its name or its click is a mistake in the
// file, and fails the configuration rather than being skipped: a state quietly
// left out is a part of the page quietly left unchecked.

// A name is what a finding reached there carries (`at`), and what its level
// is keyed by: `color-contrast@menu`. Kept to what reads well in both.
const NAME = /^[A-Za-z0-9][\w-]*$/;

export class InvalidStates extends Error {}

const FORM_FACTORS = ['mobile', 'desktop'];

// The states, as a flat list of { name, click, from, formFactor, waitFor,
// close, generated } — each of the last five only when it says something, a
// form factor inherited from the state above — parents before the states
// under them. Nothing declared is no state. Anything the file got wrong
// throws, naming the state.
//
// What it returns it reads back the same: the list crosses into the audit's
// worker as plain data and is read there again, `from` in place of the
// nesting.
export function parseStates(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidStates('states: must be a list');

  const formFactors = new Map();
  const out = [];
  const read = (list, where, parent) => list.forEach((state, i) => {
    const at = `${where}[${i}]`;
    if (!isPlainObject(state)) throw new InvalidStates(`${at} must be a mapping with a name and a click`);
    const { name, click, close, states: under } = state;
    const waitFor = state.wait_for ?? state.waitFor;
    const declaredFormFactor = state.form_factor ?? state.formFactor;
    const from = parent ?? state.from;

    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new InvalidStates(`${at} needs a name — letters, digits, - and _`);
    }
    if (formFactors.has(name)) throw new InvalidStates(`${at}: the name ${name} is taken by an earlier state`);
    if (parent != null && state.from != null) throw new InvalidStates(`${at} (${name}): a state listed under another starts from it, and says no from`);
    if (from != null && (typeof from !== 'string' || !formFactors.has(from))) {
      throw new InvalidStates(`${at} (${name}): from must name a state declared before it`);
    }
    if (declaredFormFactor != null && !FORM_FACTORS.includes(declaredFormFactor)) {
      throw new InvalidStates(`${at} (${name}): form_factor must be ${FORM_FACTORS.join(' or ')}`);
    }
    const inherited = from == null ? null : formFactors.get(from);
    if (declaredFormFactor != null && inherited != null && declaredFormFactor !== inherited) {
      throw new InvalidStates(`${at} (${name}): reached from ${from}, which is only on ${inherited}`);
    }
    const formFactor = declaredFormFactor ?? inherited;
    formFactors.set(name, formFactor);
    if (typeof click !== 'string' || click.trim() === '') {
      throw new InvalidStates(`${at} (${name}) needs a click: the selector of the element that opens it`);
    }
    if (waitFor != null && (typeof waitFor !== 'string' || waitFor.trim() === '')) {
      throw new InvalidStates(`${at} (${name}): wait_for must be a selector`);
    }
    if (close != null && (typeof close !== 'string' || close.trim() === '')) {
      throw new InvalidStates(`${at} (${name}): close must be a selector`);
    }
    if (under != null && !Array.isArray(under)) throw new InvalidStates(`${at} (${name}): states must be a list`);

    out.push({
      name,
      click,
      ...(from != null ? { from } : {}),
      ...(formFactor != null ? { formFactor } : {}),
      ...(waitFor != null ? { waitFor } : {}),
      ...(close != null ? { close } : {}),
      ...(state.generated === true ? { generated: true } : {}),
    });
    if (under) read(under, `${at}.states`, name);
  });
  read(value, 'states', null);
  return out;
}

// The states a project wrote by hand and the ones `kanso discover` found, as
// one list: the project's first, then the ones found, each marked
// `generated`.
//
// A state found that the project already declares — the same clicks, from
// the page as it loads — is the project's: it is left out, and the states
// found under it are reached from the project's. A state found under one
// that the project keeps to the other screen cannot be reached, and is left
// out with the states under it. A name found that the project took since the
// click-through is a file to generate again, and says so.
export function combineStates(declared, generated) {
  if (generated.length === 0) return declared;
  const byPath = new Map();
  const wayOf = (states) => (state) => [...pathTo(states, state), state].map((s) => s.click).join('\n');
  const declaredWay = wayOf(declared);
  for (const state of declared) byPath.set(declaredWay(state), state);
  const taken = new Map(declared.map((s) => [s.name, s]));

  const generatedWay = wayOf(generated);
  const renamed = new Map();
  const dropped = new Set();
  const kept = [];
  for (const state of generated) {
    if (state.from != null && dropped.has(state.from)) {
      dropped.add(state.name);
      continue;
    }
    const same = byPath.get(generatedWay(state));
    if (same) {
      renamed.set(state.name, same.name);
      continue;
    }
    if (taken.has(state.name)) {
      throw new InvalidStates(`the state ${state.name} found by kanso discover is also a name in .kanso.yml — run kanso discover --write again`);
    }
    const from = state.from == null ? undefined : renamed.get(state.from) ?? state.from;
    const above = from == null ? null : taken.get(from);
    const formFactor = state.formFactor ?? above?.formFactor;
    if (above?.formFactor != null && state.formFactor != null && above.formFactor !== state.formFactor) {
      dropped.add(state.name);
      continue;
    }
    const entry = {
      name: state.name,
      click: state.click,
      ...(from != null ? { from } : {}),
      ...(formFactor != null ? { formFactor } : {}),
      ...(state.waitFor != null ? { waitFor: state.waitFor } : {}),
      ...(state.close != null ? { close: state.close } : {}),
      generated: true,
    };
    taken.set(entry.name, entry);
    kept.push(entry);
  }
  // Parents before the states under them, which a walk needs: a state found
  // under one of the project's comes after it, since the project's are first.
  return [...declared, ...kept];
}

// The states on `formFactor`'s screen. A state's way there is on it too, so
// every state it starts from is still in the list.
export function statesOn(states, formFactor) {
  return states.filter((state) => state.formFactor == null || state.formFactor === formFactor);
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
