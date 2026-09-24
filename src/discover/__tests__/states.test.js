import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { parseStates } from '../../config/states.js';
import { renderStatesFile, slug, stateNames, statesFrom } from '../states.js';

// What one screen's exploration hands back, the ids its own.
const node = (id, parent, click, name, { role = 'button', waitFor = null, ...more } = {}) => ({ id, parent, click, waitFor, role, name, ...more });

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

// The flat form the configuration reads a nested tree into: what an audit
// goes through.
const flat = (states) => parseStates(states).map((s) => [s.name, s.from ?? null, s.formFactor ?? null]);

test('a state both screens reached the same way is one state, on both, holding what is reached from it', () => {
  const states = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS, MENU, { ...SIGNUP }] });
  assert.deepEqual(states, [
    {
      name: 'menu', click: '#menu-toggle', wait_for: '#menu-toggle[aria-expanded="true"]',
      states: [{ name: 'sign-up', click: '::-p-aria([name="Sign up"][role="link"])' }],
    },
    { name: 'settings', click: '[data-testid="settings"]', wait_for: '::-p-aria([name="Settings"][role="dialog"])' },
  ]);
  assert.deepEqual(flat(states), [['menu', null, null], ['sign-up', 'menu', null], ['settings', null, null]]);
});

test('a state\'s keys come in the order the file writes them, and only those that say something', () => {
  const states = statesFrom({ mobile: [MENU, SIGNUP], desktop: null });
  assert.deepEqual(Object.keys(states[0]), ['name', 'form_factor', 'click', 'wait_for', 'states']);
  assert.deepEqual(Object.keys(states[0].states[0]), ['name', 'click']);
});

// Ids mean nothing outside the exploration that gave them: the way there is
// what makes two states one.
test('the same way on both screens is the same state, whatever ids each exploration gave it', () => {
  const desktop = [node(7, null, '#menu-toggle', 'Menu'), node(9, 7, SIGNUP.click, 'Sign up', { role: 'link' })];
  const states = statesFrom({ mobile: [MENU, SIGNUP], desktop });
  assert.deepEqual(stateNames(states), ['menu', 'sign-up']);
  assert.equal(JSON.stringify(states).includes('form_factor'), false);
});

test('the same click from another state is another state, and names are unique across the tree', () => {
  const close = (id, parent) => node(id, parent, '#close', 'Close');
  const states = statesFrom({ mobile: [MENU, SETTINGS, close(4, 1), close(5, 3)], desktop: null });
  assert.deepEqual(states.map((s) => [s.name, s.states.map((c) => c.name)]), [['menu', ['close']], ['settings', ['close-2']]]);
  assert.deepEqual(flat(states), [['menu', null, 'mobile'], ['close', 'menu', 'mobile'], ['settings', null, 'mobile'], ['close-2', 'settings', 'mobile']]);
});

test('a state one screen reached alone says which, and a child never repeats its parent\'s', () => {
  const drawer = node(1, null, '#burger', 'Open the menu');
  const account = node(2, 1, '#account', 'Account');
  const hover = node(4, 3, '#more', 'More');
  const states = statesFrom({
    mobile: [drawer, account, node(3, null, '#search', 'Search')],
    desktop: [node(1, null, '#search', 'Search'), node(2, null, '#mega', 'Products'), { ...hover, parent: 1 }],
  });
  assert.deepEqual(states, [
    { name: 'open-the-menu', form_factor: 'mobile', click: '#burger', states: [{ name: 'account', click: '#account' }] },
    // Its parent is on both screens: nothing says this one is on the desktop alone but itself.
    { name: 'search', click: '#search', states: [{ name: 'more', form_factor: 'desktop', click: '#more' }] },
    { name: 'products', form_factor: 'desktop', click: '#mega' },
  ]);
  assert.deepEqual(flat(states), [
    ['open-the-menu', null, 'mobile'], ['account', 'open-the-menu', 'mobile'],
    ['search', null, null], ['more', 'search', 'desktop'],
    ['products', null, 'desktop'],
  ]);
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

test('a found state takes no name already taken, in the tree or by the project', () => {
  const states = statesFrom(
    { mobile: [node(1, null, '#a', 'Menu'), node(2, null, '#b', 'Menu'), node(3, null, '#c', ''), node(4, 1, '#d', 'Menu')], desktop: null },
    { taken: ['menu', 'button'] },
  );
  assert.deepEqual(stateNames(states), ['menu-2', 'menu-4', 'menu-3', 'button-2']);
  assert.doesNotThrow(() => parseStates(states));
});

test('a node whose parent the exploration does not list is left out, with what is below it', () => {
  const states = statesFrom({ mobile: [MENU, node(5, 42, '#x', 'Orphan'), node(6, 5, '#y', 'Below')], desktop: null });
  assert.deepEqual(stateNames(states), ['menu']);
});

test('what an exploration found always reads as a valid states: tree', () => {
  const mobile = [MENU, SIGNUP, SETTINGS, node(4, 2, '#terms', 'Terms'), node(5, 3, '#tab', 'Privacy')];
  const desktop = [SETTINGS, node(8, 3, '#tab', 'Privacy'), node(9, 3, '#other', 'Other'), node(10, 9, '#deeper', 'Deeper')];
  const states = statesFrom({ mobile, desktop });
  assert.deepEqual(flat(states), [
    ['menu', null, 'mobile'], ['sign-up', 'menu', 'mobile'], ['terms', 'sign-up', 'mobile'],
    ['settings', null, null], ['privacy', 'settings', null], ['other', 'settings', 'desktop'], ['deeper', 'other', 'desktop'],
  ]);
});

test('every name in a tree, parents before their children, and none in what is not one', () => {
  assert.deepEqual(stateNames([{ name: 'a', states: [{ name: 'b', states: [{ name: 'c' }] }] }, { name: 'd' }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(stateNames(undefined), []);
  assert.deepEqual(stateNames('states'), []);
  assert.deepEqual(stateNames([null, { click: '#x' }]), []);
});

// ── writing them ──

const NASTY = [
  {
    name: 'dont', click: '::-p-aria([name="Don\'t"][role="button"])', wait_for: '#a\\:b', close: "[data-x='1']",
    states: [{ name: 'child', click: '#x # not a comment: really', wait_for: "a[href^='http']", states: [{ name: 'deep', click: "\n\t'" }] }],
  },
  { name: 'true', form_factor: 'mobile', click: '- [ ] {x}' },
  { name: '2fa', click: '&anchor *alias !tag %dir @at `tick`' },
  { name: '123', click: '"double"' },
];

test('the file reads back as the states it was made from', () => {
  for (const states of [NASTY, statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [MENU] })]) {
    assert.deepEqual(yaml.load(renderStatesFile(states)), { states });
  }
});

test('the file says it is generated, writes names plain and selectors single-quoted, a top-level state per paragraph', () => {
  const text = renderStatesFile([
    { name: 'menu', form_factor: 'mobile', click: '#menu', wait_for: "[aria-expanded='true']", states: [
      { name: 'signup', click: '#signup', states: [{ name: 'terms', click: '#terms' }] },
      { name: 'login', click: '#login' },
    ] },
    { name: 'search', click: '#search', close: '#search-close' },
  ]);
  const [header, body] = text.split('\n\nstates:\n');
  assert.match(header, /^# Generated by `kanso discover`/);
  assert.match(header, /kanso discover --write` overwrites this file whole/);
  assert.match(header, /\.kanso\.yml/);
  assert.ok(header.split('\n').every((line) => line.startsWith('#')));
  assert.equal(body, [
    '  - name: menu',
    '    form_factor: mobile',
    "    click: '#menu'",
    "    wait_for: '[aria-expanded=''true'']'",
    '    states:',
    '      - name: signup',
    "        click: '#signup'",
    '        states:',
    '          - name: terms',
    "            click: '#terms'",
    '      - name: login',
    "        click: '#login'",
    '',
    '  - name: search',
    "    click: '#search'",
    "    close: '#search-close'",
    '',
  ].join('\n'));
});

test('a name YAML would read as something else is quoted, and every other is plain', () => {
  const text = renderStatesFile(NASTY);
  assert.match(text, /- name: dont\n/);
  assert.match(text, /- name: 'true'\n/);
  assert.match(text, /- name: 2fa\n/);
  assert.match(text, /- name: '123'\n/);
  assert.match(text, /form_factor: mobile\n/);
});

test('nothing found is a file that says so, and loads as no state', () => {
  for (const states of [[], undefined]) {
    const text = renderStatesFile(states);
    assert.match(text, /^# Generated by `kanso discover`/);
    assert.match(text, /No state was found/);
    assert.deepEqual(yaml.load(text), { states: [] });
  }
});

test('the same exploration gives the same file, byte for byte', () => {
  const explored = { mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS, MENU] };
  assert.equal(renderStatesFile(statesFrom(explored)), renderStatesFile(statesFrom(structuredClone(explored))));
});

// The whole way, as `kanso discover --write` takes it, then the configuration.
test('what was found, written as a file, loads as the states it found', () => {
  const found = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS] }, { taken: ['old'] });
  assert.deepEqual(flat(yaml.load(renderStatesFile(found)).states), [
    ['menu', null, 'mobile'], ['sign-up', 'menu', 'mobile'], ['settings', null, null],
  ]);
});

// One dialog two buttons open is one state: the other button is said beside
// it, in a comment, which reads back as nothing.
test('the other elements that open a state are named beside it, from either screen, as a comment', () => {
  const dialog = (also) => node(4, null, '#account', 'Account', { alsoOpenedBy: also });
  const states = statesFrom({ mobile: [dialog(['#signin'])], desktop: [dialog(['#signin', '#hero-signin'])] });
  assert.deepEqual(states, [{ name: 'account', click: '#account', also_opened_by: ['#signin', '#hero-signin'] }]);
  const text = renderStatesFile(states);
  assert.match(text, /    click: '#account'\n    # also opened by '#signin'\n    # also opened by '#hero-signin'\n/);
  assert.deepEqual(yaml.load(text), { states: [{ name: 'account', click: '#account' }] });
});
