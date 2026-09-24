import yaml from 'js-yaml';

// What an exploration found, turned into the `states:` of .kanso/states.yml
// (src/config/states.js) — a file of its own, which `kanso discover --write`
// writes whole every time, the way a lock file is: what a click-through finds
// is regenerated rather than merged, and what a project writes by hand stays in
// its .kanso.yml, where no command rewrites it. The two are combined when the
// configuration loads, not here.
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
// here is recognized among the ones a project declared by hand, at load.

const FORM_FACTORS = ['mobile', 'desktop'];

// A name is kept short enough to read in a finding's `at` — the tree is what
// the nesting expresses, so a name never repeats its parent's.
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

// The states an exploration found, as the nested `states:` of
// .kanso/states.yml: snake case, each key only when it says something, each
// state holding under `states:` the ones reached from it. Mobile's states come
// first, in the order it found them, then those only the desktop found, in its
// order — among the top-level states and among the children of each.
//
// A state both screens reached is one state, on both. One that only a screen
// reached says so with `form_factor:` — unless its parent is already on that
// screen alone, which says it for it: a child is reached from its parent, and
// is on the parent's screen (src/config/states.js). A child never contradicts
// its parent either, as the way to it goes through the parent: a screen that
// reached the child reached the parent first.
//
// What says a state opened is kept when both screens saw the same; when they
// saw different things, or one saw nothing, it is left out, and the state is
// taken as reached once the network goes quiet (src/probes/states.js). A
// `wait_for` that holds on one screen only would fail the state on the other,
// which is worse than waiting a little longer on both.
//
// Names are unique across the whole tree — a finding's `at` names a state
// alone, not its way there — and `taken` is the names already in use, the
// project's own states, which a state found here does not take. They are
// handed out in the order the states were found, so that the same
// exploration names the same states the same way.
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
  const roots = [];
  const built = new Map();
  for (const { node, on, waitFor } of merged.values()) {
    const single = on.length === 1 ? on[0] : null;
    const parent = node.parentKey == null ? null : built.get(node.parentKey);
    const implied = parent?.on ?? null;
    const state = {
      name: unique(slug(node.name, node.role), names),
      ...(single != null && single !== implied ? { form_factor: single } : {}),
      click: node.click,
      ...(waitFor != null ? { wait_for: waitFor } : {}),
    };
    built.set(node.key, { state, on: single });
    if (parent == null) {
      roots.push(state);
    } else {
      parent.state.states ??= [];
      parent.state.states.push(state);
    }
  }
  return roots;
}

// Every name in a nested `states:`, parents before their children — what a
// generated file held, to say what a new one added and removed.
export function stateNames(states) {
  if (!Array.isArray(states)) return [];
  return states.flatMap((state) => [
    ...(typeof state?.name === 'string' ? [state.name] : []),
    ...stateNames(state?.states),
  ]);
}

// The first lines of the generated file: whose it is, and where a state to
// keep belongs instead.
const HEADER = [
  '# Generated by `kanso discover`: the states it found by clicking through the page.',
  '# `kanso discover --write` overwrites this file whole, so an edit made here is lost.',
  '# A state to keep by hand belongs in .kanso.yml, under states:, which is read',
  '# alongside this file and wins over it when both reach the same state.',
];

// The order a state's keys are written in: what it is called and on which
// screen, then how it is reached, what says so and what closes it, then what
// is reached from it.
const KEY_ORDER = ['name', 'form_factor', 'click', 'wait_for', 'close', 'states'];

// A name or a screen is written plain when YAML reads it back as the same
// string — and a word some YAML reader would take for a boolean is quoted
// even where js-yaml would not. Every other string is a selector, full of what
// YAML gives a meaning to — `#`, `:`, brackets, both quotes — and is always
// single-quoted, where nothing but a quote needs escaping: it is doubled.
const PLAIN_KEYS = new Set(['name', 'form_factor']);

function scalar(key, value) {
  if (typeof value !== 'string') return JSON.stringify(value);
  if (PLAIN_KEYS.has(key) && /^[A-Za-z0-9][\w-]*$/.test(value)
    && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value) && yaml.load(value) === value) {
    return value;
  }
  // A line break would be folded into a space inside single quotes; a
  // double-quoted string, which is JSON's, keeps it as it is.
  if (/[\n\r\t]/.test(value)) return JSON.stringify(value);
  return `'${value.replaceAll("'", "''")}'`;
}

// One state and what is reached from it, as the lines of a list item `depth`
// levels down: its dash two spaces in from the key that holds the list, its
// keys two further.
function renderState(state, depth) {
  const dash = ' '.repeat(2 + 4 * depth);
  const indent = ' '.repeat(4 + 4 * depth);
  const keys = KEY_ORDER.filter((key) => state[key] !== undefined && !(key === 'states' && !state.states?.length));
  return keys.flatMap((key, i) => {
    const lead = i === 0 ? `${dash}- ` : indent;
    if (key === 'states') return [`${lead}states:`, ...state.states.flatMap((child) => renderState(child, depth + 1))];
    return [`${lead}${key}: ${scalar(key, state[key])}`];
  });
}

// The whole of .kanso/states.yml for `states`, a tree as statesFrom makes it:
// the header, then the states, a blank line between two top-level ones so that
// each reads as one. Nothing found is a file that says so — and still a valid
// one, which loads as no state.
export function renderStatesFile(states) {
  const header = HEADER.join('\n');
  if (!states?.length) return `${header}\n\n# No state was found.\nstates: []\n`;
  const items = states.map((state) => renderState(state, 0).join('\n'));
  return `${header}\n\nstates:\n${items.join('\n\n')}\n`;
}
