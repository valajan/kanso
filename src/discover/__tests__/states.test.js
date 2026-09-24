import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { parseStates } from '../../config/states.js';
import { mergeStates, renderStates, slug, statesFrom, writeStates } from '../states.js';

// What one screen's exploration hands back, the ids its own.
const node = (id, parent, click, name, { role = 'button', waitFor = null } = {}) => ({ id, parent, click, waitFor, role, name });

const MENU = node(1, null, '#menu-toggle', 'Menu', { waitFor: '#menu-toggle[aria-expanded="true"]' });
const SIGNUP = node(2, 1, '::-p-aria([name="Sign up"][role="link"])', 'Sign up', { role: 'link' });
const SETTINGS = node(3, null, '[data-testid="settings"]', 'Settings', { waitFor: '::-p-aria([name="Settings"][role="dialog"])' });

test('an element\'s accessible name makes a short, plain name, and its role one when the name is empty', () => {
  assert.equal(slug('Sign up', 'link'), 'sign-up');
  assert.equal(slug('  Réglages du compte ', 'button'), 'reglages-du-compte');
  assert.equal(slug('Ouvrir le menu de navigation principale', 'button'), 'ouvrir-le-menu-de');
  assert.equal(slug('Ouvrir le menu principal', 'button'), 'ouvrir-le-menu-principal');
  assert.equal(slug('Supercalifragilisticexpialidocious', 'button'), 'supercalifragilisticexpi');
  assert.equal(slug('×', 'button'), 'button');
  assert.equal(slug('', 'menuitem'), 'menuitem');
  assert.equal(slug(null, null), 'state');
  assert.equal(slug('— Search —', 'button'), 'search');
});

test('a state both screens reached the same way is one state, on both', () => {
  const states = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS, MENU, { ...SIGNUP }] });
  assert.deepEqual(states, [
    { name: 'menu', click: '#menu-toggle', wait_for: '#menu-toggle[aria-expanded="true"]' },
    { name: 'sign-up', from: 'menu', click: '::-p-aria([name="Sign up"][role="link"])' },
    { name: 'settings', click: '[data-testid="settings"]', wait_for: '::-p-aria([name="Settings"][role="dialog"])' },
  ]);
  assert.doesNotThrow(() => parseStates(states));
});

// Ids mean nothing outside the exploration that gave them: the way there is
// what makes two states one.
test('the same way on both screens is the same state, whatever ids each exploration gave it', () => {
  const desktop = [node(7, null, '#menu-toggle', 'Menu'), node(9, 7, SIGNUP.click, 'Sign up', { role: 'link' })];
  const states = statesFrom({ mobile: [MENU, SIGNUP], desktop });
  assert.deepEqual(states.map((s) => s.name), ['menu', 'sign-up']);
  assert.equal(states.some((s) => 'form_factor' in s), false);
});

test('the same click from another state is another state', () => {
  const close = (id, parent) => node(id, parent, '#close', 'Close');
  const states = statesFrom({ mobile: [MENU, SETTINGS, close(4, 1), close(5, 3)], desktop: null });
  assert.deepEqual(states.map((s) => [s.name, s.from ?? null]), [['menu', null], ['settings', null], ['close', 'menu'], ['close-2', 'settings']]);
});

test('a state one screen reached alone says which, and what is reached through it does not repeat it', () => {
  const drawer = node(1, null, '#burger', 'Open the menu');
  const account = node(2, 1, '#account', 'Account');
  const hover = node(4, 3, '#more', 'More');
  const states = statesFrom({
    mobile: [drawer, account, node(3, null, '#search', 'Search')],
    desktop: [node(1, null, '#search', 'Search'), node(2, null, '#mega', 'Products'), { ...hover, parent: 1 }],
  });
  assert.deepEqual(states, [
    { name: 'open-the-menu', form_factor: 'mobile', click: '#burger' },
    { name: 'account', from: 'open-the-menu', click: '#account' },
    { name: 'search', click: '#search' },
    { name: 'products', form_factor: 'desktop', click: '#mega' },
    // Its parent is on both screens: nothing says this one is on the desktop alone but itself.
    { name: 'more', from: 'search', form_factor: 'desktop', click: '#more' },
  ]);
  const parsed = parseStates(states);
  assert.deepEqual(parsed.map((s) => s.formFactor ?? null), ['mobile', 'mobile', null, 'desktop', 'desktop']);
});

test('a screen not explored finds nothing, and a state only the other found is on that screen', () => {
  assert.deepEqual(statesFrom({ mobile: null, desktop: null }), []);
  assert.deepEqual(statesFrom({ mobile: [], desktop: [] }), []);
  assert.deepEqual(statesFrom({ mobile: [MENU], desktop: null }), [
    { name: 'menu', form_factor: 'mobile', click: '#menu-toggle', wait_for: '#menu-toggle[aria-expanded="true"]' },
  ]);
});

// A wait_for that holds on one screen only would fail the state on the other.
test('what says a state opened is kept only when both screens saw the same', () => {
  const on = (waitFor) => ({ ...MENU, waitFor });
  const waitFor = (mobile, desktop) => statesFrom({ mobile: [on(mobile)], desktop: [on(desktop)] })[0].wait_for;
  assert.equal(waitFor('#menu', '#menu'), '#menu');
  assert.equal(waitFor('#menu', '#nav'), undefined);
  assert.equal(waitFor('#menu', null), undefined);
  assert.equal(waitFor(null, '#menu'), undefined);
});

test('a found state takes no name already taken, in the list or in the project', () => {
  const states = statesFrom(
    { mobile: [node(1, null, '#a', 'Menu'), node(2, null, '#b', 'Menu'), node(3, null, '#c', '')], desktop: null },
    { taken: ['menu', 'button'] },
  );
  assert.deepEqual(states.map((s) => s.name), ['menu-2', 'menu-3', 'button-2']);
  assert.doesNotThrow(() => parseStates(states));
});

test('a node whose parent the exploration does not list is left out, with what is below it', () => {
  const states = statesFrom({ mobile: [MENU, node(5, 42, '#x', 'Orphan'), node(6, 5, '#y', 'Below')], desktop: null });
  assert.deepEqual(states.map((s) => s.name), ['menu']);
});

test('what an exploration found always reads as a valid states: block, every from naming an earlier state', () => {
  const mobile = [MENU, SIGNUP, SETTINGS, node(4, 2, '#terms', 'Terms'), node(5, 3, '#tab', 'Privacy')];
  const desktop = [SETTINGS, node(8, 3, '#tab', 'Privacy'), node(9, 3, '#other', 'Other'), node(10, 9, '#deeper', 'Deeper')];
  const states = statesFrom({ mobile, desktop });
  const parsed = parseStates(states);
  const seen = new Set();
  for (const state of parsed) {
    if (state.from) assert.ok(seen.has(state.from), `${state.name} starts from ${state.from}, declared before it`);
    seen.add(state.name);
  }
  assert.deepEqual(parsed.map((s) => [s.name, s.formFactor ?? null]), [
    ['menu', 'mobile'], ['sign-up', 'mobile'], ['settings', null], ['terms', 'mobile'], ['privacy', null], ['other', 'desktop'], ['deeper', 'desktop'],
  ]);
});

// ── merging with what the project declared ──

const DECLARED = [
  { name: 'nav', click: '#menu-toggle', close: '#menu-close' },
  { name: 'profile', form_factor: 'desktop', click: '#avatar' },
];

test('what the project declared comes first, as it wrote it, and a state it declared is not added again', () => {
  const found = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [MENU, SIGNUP, SETTINGS] });
  const { states, added, kept } = mergeStates(DECLARED, found);
  assert.deepEqual(states, [
    ...DECLARED,
    { name: 'sign-up', from: 'nav', click: SIGNUP.click },
    { name: 'settings', click: SETTINGS.click, wait_for: SETTINGS.waitFor },
  ]);
  assert.equal(states[0], DECLARED[0]);
  assert.deepEqual(added, ['sign-up', 'settings']);
  assert.deepEqual(kept, ['nav', 'profile']);
  assert.doesNotThrow(() => parseStates(states));
});

test('a state the project declared through from is recognized by its way, not its name', () => {
  const declared = [{ name: 'nav', click: '#menu-toggle' }, { name: 'join', from: 'nav', click: SIGNUP.click }];
  const found = statesFrom({ mobile: [MENU, SIGNUP, node(4, 2, '#terms', 'Terms')], desktop: [MENU, SIGNUP, node(4, 2, '#terms', 'Terms')] });
  const { states, added } = mergeStates(declared, found);
  assert.deepEqual(states.slice(2), [{ name: 'terms', from: 'join', click: '#terms' }]);
  assert.deepEqual(added, ['terms']);
});

test('a found name the project uses for another state is renamed, and every from naming it follows', () => {
  const declared = [{ name: 'settings', click: '#prefs' }];
  const found = [
    { name: 'settings', click: '#settings' },
    { name: 'privacy', from: 'settings', click: '#privacy' },
  ];
  const { states, added } = mergeStates(declared, found);
  assert.deepEqual(states, [
    { name: 'settings', click: '#prefs' },
    { name: 'settings-2', click: '#settings' },
    { name: 'privacy', from: 'settings-2', click: '#privacy' },
  ]);
  assert.deepEqual(added, ['settings-2', 'privacy']);
});

test('on which screen a state is, the project\'s word is taken over the exploration\'s', () => {
  const declared = [{ name: 'drawer', form_factor: 'mobile', click: '#burger' }, { name: 'nav', click: '#nav' }];
  const found = [
    // Found on both screens: the project says mobile, and so the menu.
    { name: 'burger', click: '#burger' },
    { name: 'links', from: 'burger', click: '#links' },
    // Found on the desktop alone, through a state the project keeps to mobile: unreachable, dropped with its own.
    { name: 'wide', from: 'burger', form_factor: 'desktop', click: '#wide' },
    { name: 'wider', from: 'wide', click: '#wider' },
    // Found on mobile alone, through a mobile state: the form_factor repeats what from says.
    { name: 'account', from: 'burger', form_factor: 'mobile', click: '#account' },
    // Found under a state the exploration had on mobile alone, which the project declared on both.
    { name: 'nav-found', form_factor: 'mobile', click: '#nav' },
    { name: 'sub', from: 'nav-found', click: '#sub' },
  ];
  const { states, added } = mergeStates(declared, found);
  assert.deepEqual(states.slice(2), [
    { name: 'links', from: 'drawer', click: '#links' },
    { name: 'account', from: 'drawer', click: '#account' },
    { name: 'sub', from: 'nav', form_factor: 'mobile', click: '#sub' },
  ]);
  assert.deepEqual(added, ['links', 'account', 'sub']);
  assert.deepEqual(parseStates(states).map((s) => s.formFactor ?? null), ['mobile', null, 'mobile', 'mobile', 'mobile']);
});

test('a project with no state takes every one found, and one with nothing found keeps its own', () => {
  const found = statesFrom({ mobile: [MENU], desktop: [MENU] });
  assert.deepEqual(mergeStates(undefined, found), { states: found, added: ['menu'], kept: [] });
  assert.deepEqual(mergeStates([], found).states, found);
  assert.deepEqual(mergeStates(DECLARED, []), { states: DECLARED, added: [], kept: ['nav', 'profile'] });
});

// ── writing them ──

const NASTY = [
  { name: 'dont', click: '::-p-aria([name="Don\'t"][role="button"])', wait_for: '#a\\:b', close: "[data-x='1']" },
  { name: 'child', from: 'dont', form_factor: 'mobile', click: '#x # not a comment: really', wait_for: "a[href^='http']" },
  { name: 'true', click: '- [ ] {x}' },
  { name: '2fa', click: '&anchor *alias !tag %dir @at `tick`' },
];

test('the rendered block reads back as the states it was made from', () => {
  for (const states of [NASTY, DECLARED, statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [MENU] })]) {
    assert.deepEqual(yaml.load(renderStates(states)).states, states);
  }
  assert.deepEqual(yaml.load(renderStates([])), { states: [] });
});

test('the rendered block writes names plain and selectors single-quoted, a state per paragraph', () => {
  assert.equal(renderStates([
    { click: '#menu', name: 'menu', wait_for: "[aria-expanded='true']" },
    { name: 'signup', from: 'menu', form_factor: 'mobile', click: '#signup' },
  ]), [
    'states:',
    '  - name: menu',
    "    click: '#menu'",
    "    wait_for: '[aria-expanded=''true'']'",
    '',
    '  - name: signup',
    '    from: menu',
    '    form_factor: mobile',
    "    click: '#signup'",
    '',
  ].join('\n'));
});

const FILE = [
  '# Kanso, for this project',
  'runs: 3',
  '',
  'states:',
  '  - name: old',
  '    click: "#old"',
  '    # an indented comment inside the block',
  '',
  '# Budgets: the numbers the team agreed on.',
  'budgets:',
  '  lcp: 2500 # ms',
  '',
].join('\n');

test('writing the states replaces the block, and every other byte of the file stays', () => {
  const written = writeStates(FILE, DECLARED);
  assert.equal(written, [
    '# Kanso, for this project',
    'runs: 3',
    '',
    renderStates(DECLARED) + '',
    '# Budgets: the numbers the team agreed on.',
    'budgets:',
    '  lcp: 2500 # ms',
    '',
  ].join('\n'));
  const before = yaml.load(FILE);
  const after = yaml.load(written);
  assert.deepEqual(after.states, DECLARED);
  assert.deepEqual({ ...after, states: null }, { ...before, states: null });
});

test('a block written flush under its key, or last in the file, is replaced whole', () => {
  const flush = 'states:\n- name: old\n  click: "#old"\nruns: 2\n';
  assert.equal(writeStates(flush, DECLARED), `${renderStates(DECLARED)}runs: 2\n`);

  const last = 'runs: 2\nstates:\n  - name: old\n    click: "#old"\n';
  assert.equal(writeStates(last, DECLARED), `runs: 2\n${renderStates(DECLARED)}`);

  const noNewline = 'runs: 2\nstates:\n  - name: old\n    click: "#old"';
  assert.equal(writeStates(noNewline, DECLARED), `runs: 2\n${renderStates(DECLARED)}`);

  const tail = 'states:\n  - name: old\n    click: "#old"\n\n# the end\n';
  assert.equal(writeStates(tail, DECLARED), `${renderStates(DECLARED)}\n# the end\n`);
});

test('states written inline are replaced, line and all', () => {
  assert.equal(writeStates('runs: 2\nstates: []\nbudgets:\n  cls: 0.1\n', DECLARED), `runs: 2\n${renderStates(DECLARED)}budgets:\n  cls: 0.1\n`);
  const inline = 'states: [{ name: old, click: "#old" }]  # to redo\nruns: 2\n';
  assert.equal(writeStates(inline, DECLARED), `${renderStates(DECLARED)}runs: 2\n`);
  const spread = 'states: [\n  { name: old, click: "#old" }\n  ]\nruns: 2\n';
  assert.equal(writeStates(spread, DECLARED), `${renderStates(DECLARED)}runs: 2\n`);
});

test('a file with no states gets them at its end, after a blank line', () => {
  assert.equal(writeStates('runs: 2\n', DECLARED), `runs: 2\n\n${renderStates(DECLARED)}`);
  assert.equal(writeStates('runs: 2', DECLARED), `runs: 2\n\n${renderStates(DECLARED)}`);
  assert.equal(writeStates('runs: 2\n\n', DECLARED), `runs: 2\n\n${renderStates(DECLARED)}`);
  // A key that only starts with the word is not the block.
  assert.equal(writeStates('states_seen: 1\n', DECLARED), `states_seen: 1\n\n${renderStates(DECLARED)}`);
  assert.deepEqual(yaml.load(writeStates('# comments only\nruns: 2 # three was slow\n', NASTY)), { runs: 2, states: NASTY });
});

test('a file that does not exist yet is the block alone', () => {
  assert.equal(writeStates(null, DECLARED), renderStates(DECLARED));
  assert.equal(writeStates('', DECLARED), renderStates(DECLARED));
  assert.equal(writeStates(undefined, []), 'states: []\n');
});

test('writing states twice gives the same file as writing them once', () => {
  const once = writeStates(FILE, NASTY);
  assert.equal(writeStates(once, NASTY), once);
});

// The whole way, as `kanso discover` takes it: found, merged with the file's
// own, written back — and read by the configuration as it would be.
test('what was found, merged into a project\'s file, loads as its configuration', () => {
  const existing = yaml.load(FILE).states;
  const found = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS] }, { taken: existing.map((s) => s.name) });
  const { states } = mergeStates(existing, found);
  const written = writeStates(FILE, states);
  const loaded = yaml.load(written);
  assert.equal(loaded.runs, 3);
  assert.deepEqual(loaded.budgets, { lcp: 2500 });
  assert.deepEqual(parseStates(loaded.states).map((s) => [s.name, s.from ?? null, s.formFactor ?? null]), [
    ['old', null, null], ['menu', null, 'mobile'], ['sign-up', 'menu', 'mobile'], ['settings', null, null],
  ]);
  assert.ok(written.includes('# Budgets: the numbers the team agreed on.\nbudgets:'));
});
