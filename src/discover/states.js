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
//   { mobile: [{ id, parent, click, waitFor, role, name, close?, alsoOpenedBy? }, …] | null,
//     desktop: … }
//
// A state is known by its way there: the elements clicked, from the page as it
// loads, down to it. Two screens that clicked the same things reached the same
// state — the node ids an exploration hands out mean nothing outside it, and a
// name is something this file makes up. The same way is also how a state found
// here is recognized among the ones a project declared by hand, at load.

const FORM_FACTORS = ['mobile', 'desktop'];

// A name is kept short enough to read in a finding's `at` — the tree is what
// the nesting expresses, so a name repeats its parent's only where its own
// says too little (`nameOf`).
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

// A long name cut between two words where it can be, so as not to end on half
// of one.
function cut(words, length = NAME_LENGTH) {
  if (words.length <= length) return words;
  const upTo = words.slice(0, length + 1);
  const between = upTo.lastIndexOf('-');
  return between > 0 ? upTo.slice(0, between) : upTo.slice(0, length);
}

// The symbols that carry a value, said as a word rather than dropped: a
// "2 €" button is `2-eur`, where it was a bare `2`. Only those that read the
// same in any language the page is written in.
const SYMBOLS = [['€', 'eur'], ['$', 'dollar'], ['£', 'gbp'], ['¥', 'yen'], ['%', 'pct'], ['+', 'plus']];

// Text folded to lowercase ASCII words — accents stripped rather than
// dropped, so that « Réglages » reads `reglages` — and cut to a name's length.
function fold(text) {
  let words = String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '');
  for (const [symbol, word] of SYMBOLS) words = words.replaceAll(symbol, ` ${word} `);
  return cut(words.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''));
}

// What an element is called, as a state's name: its accessible name folded,
// and its role when the name leaves nothing, as an icon button's does.
export function slug(name, role) {
  return fold(name) || fold(role) || 'state';
}

// A name that says little out of its place: no letter at all (`2`), or one
// short word (`all`, `other`, `close`) — six letters or fewer.
const SHORT_WORD = 6;
const weak = (base) => !/[a-z]/.test(base) || (!base.includes('-') && base.length <= SHORT_WORD);

// The name the page's author gave the element, when it is clicked by its id
// alone and the id is two words or more (`#moreOptions`, `#menu-toggle`). An id
// of one word, or with a digit in it, may be anything, and is not used.
function idName(click) {
  const id = /^#([A-Za-z][\w-]*)$/.exec(click ?? '')?.[1];
  if (!id || /\d/.test(id)) return null;
  const words = id.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase().split(/[-_]+/).filter(Boolean);
  return words.length >= 2 ? cut(words.join('-')) : null;
}

// A state's name, from its element's (`slug`), made to say more where it
// says too little, in this order:
//   - under a parent, a weak name, or one another state would take too (four
//     "Close" buttons, each in its own dialog), is its parent's name and its
//     own: `sign-in-close` rather than `close-2`, which says nothing of
//     which one it is;
//   - at the top, a weak name is the id the page's author gave the element
//     when there is one worth it (`idName`), and a name with no letter says
//     what it is before it (`button-2`);
//   - what is still taken takes the first free number, as before.
// Nothing but what the exploration handed back, and in the order it found
// the states: the same exploration names them the same way.
function nameOf(node, parentName, shared) {
  const base = slug(node.name, node.role);
  if (parentName != null) return weak(base) || shared ? `${cut(parentName)}-${base}` : base;
  if (!weak(base)) return base;
  return idName(node.click) ?? (/[a-z]/.test(base) ? base : `${fold(node.role) || 'state'}-${base}`);
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
// The other elements that opened a state from where it is opened — on either
// screen — are said beside it, `also_opened_by`, which the file writes as a
// comment: one state is audited once, whichever of its triggers is clicked,
// and the comment says where the others went.
//
// What says a state opened is kept when both screens saw the same; when they
// saw different things, or one saw nothing, it is left out, and the state is
// taken as reached once the network goes quiet (src/probes/states.js). A
// `wait_for` that holds on one screen only would fail the state on the other,
// which is worse than waiting a little longer on both.
//
// What closes a state, `close:`, is kept the same way: a drawer's close button
// a phone's layout alone shows would fail, clicked on a desktop, every check
// that closes the drawer there. Left out, the state is closed as it is when
// nothing is declared — Escape, then a click away from it — on both.
//
// At most `max` states are kept, counted as the file holds them — a state on
// both screens is one — since what an audit costs goes by the states it goes
// through (`auditSeconds`). They are kept breadth first: every top-level state
// before any state reached from one, and so on down, each level in the order
// it was found. A state is never kept without its parent, which is a level up.
// The ones over the cap are handed back as `left`: the element, its role,
// its click, how deep it is and on which screens.
//
// Names are unique across the whole tree — a finding's `at` names a state
// alone, not its way there — and `taken` is the names already in use, the
// project's own states, which a state found here does not take. They are
// handed out in the order the states are kept (`nameOf`), once the cap has
// left out what it leaves out, so that no state is numbered after one that is
// not in the file.
export function discovered(explored, { taken = [], max = Infinity } = {}) {
  const screens = FORM_FACTORS.filter((formFactor) => explored?.[formFactor] != null)
    .map((formFactor) => [formFactor, waysOn(explored[formFactor])]);

  const merged = new Map();
  for (const [formFactor, found] of screens) {
    for (const [key, node] of found) {
      const state = merged.get(key);
      if (!state) {
        merged.set(key, { node, on: [formFactor], waitFor: node.waitFor ?? null, close: node.close ?? null, also: new Set(node.alsoOpenedBy) });
        continue;
      }
      state.on.push(formFactor);
      if (state.waitFor !== (node.waitFor ?? null)) state.waitFor = null;
      if (state.close !== (node.close ?? null)) state.close = null;
      for (const selector of node.alsoOpenedBy ?? []) state.also.add(selector);
    }
  }

  // Breadth first, and stable: a level's states keep the order they were found in.
  const ordered = [...merged.values()].sort((a, b) => a.node.way.length - b.node.way.length);
  const kept = ordered.slice(0, max);
  const left = ordered.slice(max).map(({ node, on }) => ({ role: node.role, name: node.name, click: node.click, depth: node.way.length, on }));

  const reserved = new Set(taken);
  const bases = new Map();
  for (const { node } of kept) {
    const base = slug(node.name, node.role);
    bases.set(base, (bases.get(base) ?? 0) + 1);
  }

  const names = new Set(taken);
  const roots = [];
  const built = new Map();
  for (const { node, on, waitFor, close, also } of kept) {
    const single = on.length === 1 ? on[0] : null;
    const parent = node.parentKey == null ? null : built.get(node.parentKey);
    const implied = parent?.on ?? null;
    const base = slug(node.name, node.role);
    const shared = bases.get(base) > 1 || reserved.has(base);
    const state = {
      name: unique(nameOf(node, parent?.state.name ?? null, shared), names),
      ...(single != null && single !== implied ? { form_factor: single } : {}),
      click: node.click,
      ...(waitFor != null ? { wait_for: waitFor } : {}),
      ...(close != null ? { close } : {}),
      ...(also.size > 0 ? { also_opened_by: [...also] } : {}),
    };
    built.set(node.key, { state, on: single });
    if (parent == null) {
      roots.push(state);
    } else {
      parent.state.states ??= [];
      parent.state.states.push(state);
    }
  }
  return { states: roots, left };
}

// The tree alone, every state kept.
export function statesFrom(explored, options) {
  return discovered(explored, options).states;
}

// How many states a `kanso discover` keeps unless told otherwise
// (`--max-states`). What an audit costs goes by its states (`auditSeconds`):
// twenty is about five minutes of audit on a page as quick as the one it was
// calibrated on, which a developer waits for before a push, and a CI job
// without anyone reaching for its timeout. A page with more states than that
// is one where each extra state is, most often, one more dialog of the same
// kind — the first twenty found are the ones a click from the page reaches.
export const MAX_STATES = 20;

// How long an audit through `states` takes, in seconds — an order of
// magnitude to print, never a promise. `extra` is the states the project
// declares by hand, flat, as the configuration holds them, which the audit
// goes through as well.
//
// Calibrated on one real audit of a page with 30 states (13 top-level, 17
// reached from another; 27 on desktop), no baseline, `runs: 1`, whose journals time every
// probe on every state:
//   - the page with no state: 16 s (Lighthouse's load 7.4-7.9 s, the
//     stateless probes 4 s, the rest Chrome starting and stopping);
//   - through the states, five probes replay each one — INP and axe (86 s and
//     84 s on mobile, 73 s and 79 s on desktop), focus (136 s, 127 s),
//     residues (126 s, 117 s), leaks (143 s, 137 s): 575 s on mobile for 30
//     states, 533 s on desktop for 27;
//   - one state could not be reached, and cost 159 s on its own: every probe
//     waits 30 s for it. Without it, a state costs 14.3 s on mobile and
//     15.2 s on desktop; its median is 13 s, a state reached from another
//     12.7 s against 18 s for a top-level one — depth does not add, what
//     costs is each probe loading the page again, and waiting on a close that
//     does not come;
//   - the audit took 597 s: the two screens run side by side, and the one
//     with more states sets the time. The model says 465 s — the gap is the
//     state that could not be reached, which a discover that replayed every
//     state it kept does not foresee.
// Hence 15 s, plus 15 s per state on the screen with more. A slower page
// costs more per state — each probe loads it again — and so does a baseline:
// four loads on three Chromes (LIGHTHOUSE_CONCURRENCY) take about twice as
// long as two.
const AUDIT_BASE_S = 15;
const AUDIT_PER_STATE_S = 15;

export function auditSeconds(states, extra = []) {
  const on = { mobile: 0, desktop: 0 };
  const count = (formFactor) => {
    for (const screen of FORM_FACTORS) if (formFactor == null || formFactor === screen) on[screen] += 1;
  };
  const walk = (list, inherited) => {
    for (const state of list ?? []) {
      const formFactor = state.form_factor ?? inherited;
      count(formFactor);
      walk(state.states, formFactor);
    }
  };
  walk(states, null);
  for (const state of extra) count(state.formFactor ?? null);
  return AUDIT_BASE_S + AUDIT_PER_STATE_S * Math.max(on.mobile, on.desktop);
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
    const line = `${lead}${key}: ${scalar(key, state[key])}`;
    if (key !== 'click') return [line];
    return [line, ...(state.also_opened_by ?? []).map((selector) => `${indent}# also opened by ${scalar(key, selector)}`)];
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
