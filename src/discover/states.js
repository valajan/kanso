import { parseStates } from '../config/states.js';

// What an exploration found, turned into the `states:` of a .kanso.yml
// (src/config/states.js) — and written into the file a project already has,
// without disturbing a byte of what it wrote there itself.
//
// An exploration goes through a page once per screen, and hands back, for each,
// every state it reached: the element clicked, the state it was clicked from,
// what says it opened, and what the element is called.
//
//   { mobile: [{ id, parent, click, waitFor, role, name }, …] | null,
//     desktop: … }
//
// A state is known by its way there: the elements clicked, from the page as it
// loads, down to it. Two screens that clicked the same things reached the same
// state — the node ids an exploration hands out mean nothing outside it, and a
// name is something this file makes up. The same way is also how a state found
// here is recognized among the ones a project already declared.

const FORM_FACTORS = ['mobile', 'desktop'];

// A name is kept short enough to read in a finding's `at` — the tree is what
// `from` expresses, so a name never repeats its parent's.
const NAME_LENGTH = 24;

// The way to a state, as one key a Map can hold: its clicks, first first.
const wayKey = (clicks) => JSON.stringify(clicks);

// The states one screen found, each with its way there. A node whose parent
// the exploration does not list has no way there, and is left out, with every
// node below it; a second node down a way already seen is the same state.
function waysOn(nodes) {
  const ways = new Map();
  const found = new Map();
  for (const node of nodes ?? []) {
    const above = node.parent == null ? [] : ways.get(node.parent);
    if (!above) continue;
    const way = [...above, node.click];
    ways.set(node.id, way);
    const key = wayKey(way);
    if (!found.has(key)) found.set(key, { ...node, way, key, parentKey: node.parent == null ? null : wayKey(above) });
  }
  return found;
}

// What an element is called, as a state's name: its accessible name folded to
// lowercase ASCII — accents stripped rather than dropped, so that « Réglages »
// reads `reglages` — and its role when the name leaves nothing, as an icon
// button's does. A long name is cut between two words where it can be, so as
// not to end on half of one.
export function slug(name, role) {
  const fold = (text) => {
    const words = String(text ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (words.length <= NAME_LENGTH) return words;
    const cut = words.slice(0, NAME_LENGTH + 1);
    const between = cut.lastIndexOf('-');
    return between > 0 ? cut.slice(0, between) : cut.slice(0, NAME_LENGTH);
  };
  return fold(name) || fold(role) || 'state';
}

// `base`, or the first of `base-2`, `base-3`… nobody has taken, and takes it.
function unique(base, taken) {
  let name = base;
  for (let n = 2; taken.has(name); n += 1) name = `${base}-${n}`;
  taken.add(name);
  return name;
}

// The states an exploration found, as the `states:` of a .kanso.yml: snake
// case, each key only when it says something, every `from` naming a state
// earlier in the list. Mobile's states come first, in the order it found them,
// then those only the desktop found, in its order — parents before children
// on each side, and a desktop state's parent is either one both screens found,
// and so already listed, or one only the desktop found, and listed before it.
//
// A state both screens reached is one state, on both. One that only a screen
// reached says so with `form_factor:` — unless the state it starts from is
// already on that screen alone, which says it for it (src/config/states.js).
//
// What says a state opened is kept when both screens saw the same; when they
// saw different things, or one saw nothing, it is left out, and the state is
// taken as reached once the network goes quiet (src/probes/states.js). A
// `wait_for` that holds on one screen only would fail the state on the other,
// which is worse than waiting a little longer on both.
//
// `taken` is the names already in use — the project's own states — which a
// state found here does not take.
export function statesFrom(explored, { taken = [] } = {}) {
  const screens = FORM_FACTORS.filter((formFactor) => explored?.[formFactor] != null)
    .map((formFactor) => [formFactor, waysOn(explored[formFactor])]);

  const merged = new Map();
  for (const [formFactor, found] of screens) {
    for (const [key, node] of found) {
      const state = merged.get(key);
      if (!state) {
        merged.set(key, { node, on: [formFactor], waitFor: node.waitFor ?? null });
        continue;
      }
      state.on.push(formFactor);
      if (state.waitFor !== (node.waitFor ?? null)) state.waitFor = null;
    }
  }

  const names = new Set(taken);
  const nameOf = new Map();
  const onOf = new Map();
  return [...merged.values()].map(({ node, on, waitFor }) => {
    const name = unique(slug(node.name, node.role), names);
    nameOf.set(node.key, name);
    const single = on.length === 1 ? on[0] : null;
    onOf.set(node.key, single);
    const from = node.parentKey == null ? null : nameOf.get(node.parentKey);
    const implied = node.parentKey == null ? null : onOf.get(node.parentKey);
    return {
      name,
      ...(from != null ? { from } : {}),
      ...(single != null && single !== implied ? { form_factor: single } : {}),
      click: node.click,
      ...(waitFor != null ? { wait_for: waitFor } : {}),
    };
  });
}

// The way to each of `states` (as a .kanso.yml writes them), by name: the
// clicks of the states it starts from, then its own.
function waysByName(states) {
  const ways = new Map();
  for (const state of states) {
    const above = state.from == null ? [] : ways.get(state.from) ?? [];
    ways.set(state.name, [...above, state.click]);
  }
  return ways;
}

// The states to write: the ones the project declared, first, as it wrote them
// — a name it chose, a `close:` it added, a comment it could not keep in a
// list anyway — and after them what the exploration found that it had not.
//
// A found state is one the project declared when both are reached the same
// way. It is dropped, and a found state that starts from it starts from the
// project's instead, under the project's name. A found name the project
// already uses is renamed, and every `from` naming it follows.
//
// On which screens a state is, the project's word is taken over the
// exploration's. A found state now starting from a declared one on a single
// screen inherits that screen, and drops a `form_factor:` that repeats it; one
// found only on the other screen cannot start from it, and is dropped with
// what is reached through it. A found state whose parent the project declared
// on both screens, when the exploration had it on one, says its screen itself
// now that its parent no longer does.
//
// `added` names the found states written, `kept` the declared ones — all of
// them, always. The declared states are read the way the configuration reads
// them, so a project whose states are wrong throws here as it would anywhere.
export function mergeStates(existing, discovered) {
  const declared = existing ?? [];
  const parsedDeclared = parseStates(declared);
  const declaredOn = new Map(parsedDeclared.map((state) => [state.name, state.formFactor ?? null]));
  const declaredByWay = new Map([...waysByName(declared)].map(([name, way]) => [wayKey(way), name]));

  const found = discovered ?? [];
  const foundOn = new Map(parseStates(found).map((state) => [state.name, state.formFactor ?? null]));
  const foundWays = waysByName(found);

  const names = new Set(declared.map((state) => state.name));
  const renamed = new Map();
  const onOf = new Map(declaredOn);
  const added = [];
  for (const state of found) {
    const same = declaredByWay.get(wayKey(foundWays.get(state.name)));
    if (same != null) {
      renamed.set(state.name, same);
      continue;
    }
    if (state.from != null && !renamed.has(state.from)) continue;

    const from = state.from == null ? null : renamed.get(state.from);
    const on = foundOn.get(state.name);
    const implied = from == null ? null : onOf.get(from);
    if (on != null && implied != null && on !== implied) continue;

    const name = unique(state.name, names);
    renamed.set(state.name, name);
    onOf.set(name, on ?? implied);
    const { name: _name, from: _from, form_factor: _formFactor, ...rest } = state;
    added.push({
      name,
      ...(from != null ? { from } : {}),
      ...(on != null && on !== implied ? { form_factor: on } : {}),
      ...rest,
    });
  }

  return {
    states: [...declared, ...added],
    added: added.map((state) => state.name),
    kept: declared.map((state) => state.name),
  };
}

// The order a state's keys are written in: what it is called and where it
// starts, then how it is reached, then what says so and what closes it. A key
// this list does not know — one a project wrote by hand — follows, as it was.
const KEY_ORDER = ['name', 'from', 'form_factor', 'formFactor', 'click', 'wait_for', 'waitFor', 'close'];

// Keys whose value is a name or a screen, written plain when YAML reads it
// back as the same string. Every other string is a selector, full of what
// YAML gives a meaning to — `#`, `:`, brackets, both quotes — and is always
// single-quoted, where nothing but a quote needs escaping: it is doubled.
const PLAIN_KEYS = new Set(['name', 'from', 'form_factor', 'formFactor']);

function scalar(key, value) {
  if (typeof value !== 'string') return JSON.stringify(value);
  if (PLAIN_KEYS.has(key) && /^[A-Za-z][\w-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value)) {
    return value;
  }
  // A line break would be folded into a space inside single quotes; a
  // double-quoted string, which is JSON's, keeps it as it is.
  if (/[\n\r\t]/.test(value)) return JSON.stringify(value);
  return `'${value.replaceAll("'", "''")}'`;
}

// `states` as the top-level `states:` block of a .kanso.yml, a blank line
// between two states so that each reads as one.
export function renderStates(states) {
  if (!states?.length) return 'states: []\n';
  const items = states.map((state) => {
    const keys = [
      ...KEY_ORDER.filter((key) => key in state),
      ...Object.keys(state).filter((key) => !KEY_ORDER.includes(key)),
    ].filter((key) => state[key] !== undefined);
    return keys.map((key, i) => `${i === 0 ? '  - ' : '    '}${key}: ${scalar(key, state[key])}`).join('\n');
  });
  return `states:\n${items.join('\n\n')}\n`;
}

// A line that starts a top-level key: anything at the first column but a
// space, a comment, or the item of a list written flush under its key. The
// markers that start or end a YAML document end a block too.
const TOP_LEVEL = /^(?:[^\s#-]|---(?:\s|$)|\.\.\.(?:\s|$))/;

// `text`, a .kanso.yml, with its `states:` replaced by `states` — every other
// byte as the project wrote it. The block runs from its `states:` line to the
// next top-level key, less the blank lines and top-level comments right above
// that key: those belong to it. Written inline (`states: []`) or across lines,
// it is replaced whole. A file with no `states:` gets one at its end, after a
// blank line; a file that does not exist yet is the block alone.
export function writeStates(text, states) {
  const block = renderStates(states);
  if (text == null || text.trim() === '') return block;

  const lines = text.split('\n');
  const starts = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }

  const first = lines.findIndex((line) => /^states\s*:/.test(line));
  if (first === -1) {
    const ending = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${ending}${block}`;
  }

  let end = lines.findIndex((line, i) => i > first && TOP_LEVEL.test(line));
  if (end === -1) end = lines.length;
  while (end - 1 > first && (lines[end - 1].trim() === '' || lines[end - 1].startsWith('#'))) end -= 1;

  const before = text.slice(0, starts[first]);
  const after = end < lines.length ? text.slice(starts[end]) : '';
  return `${before}${block}${after}`;
}
