import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { parseStates } from '../../config/states.js';
import { MAX_STATES, auditSeconds, discovered, renderStatesFile, slug, stateNames, statesFrom } from '../states.js';

// What one screen's exploration hands back, the ids its own.
const node = (id, parent, click, name, { role = 'button', waitFor = null, ...more } = {}) => ({ id, parent, click, waitFor, role, name, ...more });

const MENU = node(1, null, '#menu', 'Menu', { waitFor: '#menu[aria-expanded="true"]' });
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

// A "2 €" button was named `2`: the value was in the symbol.
test('a symbol that carries a value is said as a word rather than dropped', () => {
  assert.equal(slug('2 €', 'button'), '2-eur');
  assert.equal(slug('-20%', 'button'), '20-pct');
  assert.equal(slug('$5', 'button'), 'dollar-5');
  assert.equal(slug('+', 'button'), 'plus');
  assert.equal(slug('Tip & share', 'button'), 'tip-share');
});

test('a name that says little out of its place says where it is, or what its author called it', () => {
  const tip = node(1, null, '#moreOptions', 'More');
  const amount = node(2, null, '#pricing > div > p > button:nth-of-type(1)', '2');
  const style = node(3, null, '#filters > details > summary', 'Style');
  const burger = node(4, null, '#burger', 'Menu');
  const tabs = node(5, null, '#orders', 'My orders');
  const all = node(6, 5, '#orderTabs > button:nth-of-type(1)', 'All');
  const skip = node(7, 5, '#skip', 'Skip the video');
  const states = statesFrom({ mobile: [tip, amount, style, burger, tabs, all, skip], desktop: null });
  assert.deepEqual(stateNames(states), [
    // An id of two words is the author's name for the element; one of one word may be anything.
    'more-options', 'button-2', 'style', 'menu',
    'my-orders', 'my-orders-all', 'skip-the-video',
  ]);
});

test('a name several states would take says whose each is, and a number only when that is not enough', () => {
  const close = (id, parent) => node(id, parent, '#close', 'Close');
  const unlock = (id, parent) => node(id, parent, `#unlock${id}`, 'Upgrade the plan');
  const mobile = [
    node(1, null, '#auth', 'Sign in'), node(2, null, '#sheet', 'Calibrate'), unlock(3, null), node(4, null, '#x', 'Close'),
    close(5, 1), close(6, 2), unlock(7, 1), node(8, 1, '#auth2', 'Sign in'),
  ];
  const states = statesFrom({ mobile, desktop: null });
  assert.deepEqual(stateNames(states), [
    'sign-in', 'sign-in-close', 'sign-in-upgrade-the-plan', 'sign-in-sign-in',
    'calibrate', 'calibrate-close', 'upgrade-the-plan', 'close',
  ]);
  // Two children of one parent, with one name: the number is what is left.
  const twice = statesFrom({ mobile: [node(1, null, '#a', 'Sign in'), close(2, 1), node(3, 1, '#b', 'Close')], desktop: null });
  assert.deepEqual(stateNames(twice), ['sign-in', 'sign-in-close', 'sign-in-close-2']);
});

test('a qualified name cuts its parent\'s to a name\'s length, never its own', () => {
  const parent = node(1, null, '#p', 'Upgrade the plan to create a room');
  const states = statesFrom({ mobile: [parent, node(2, 1, '#c', 'Close')], desktop: null });
  assert.deepEqual(stateNames(states), ['upgrade-the-plan-to', 'upgrade-the-plan-to-close']);
});

// The flat form the configuration reads a nested tree into: what an audit
// goes through.
const flat = (states) => parseStates(states).map((s) => [s.name, s.from ?? null, s.formFactor ?? null]);

test('a state both screens reached the same way is one state, on both, holding what is reached from it', () => {
  const states = statesFrom({ mobile: [MENU, SIGNUP, SETTINGS], desktop: [SETTINGS, MENU, { ...SIGNUP }] });
  assert.deepEqual(states, [
    {
      name: 'menu', click: '#menu', wait_for: '#menu[aria-expanded="true"]',
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
  const desktop = [node(7, null, '#menu', 'Menu'), node(9, 7, SIGNUP.click, 'Sign up', { role: 'link' })];
  const states = statesFrom({ mobile: [MENU, SIGNUP], desktop });
  assert.deepEqual(stateNames(states), ['menu', 'sign-up']);
  assert.equal(JSON.stringify(states).includes('form_factor'), false);
});

test('the same click from another state is another state, named after the state it is reached from', () => {
  const close = (id, parent) => node(id, parent, '#close', 'Close');
  const states = statesFrom({ mobile: [MENU, SETTINGS, close(4, 1), close(5, 3)], desktop: null });
  assert.deepEqual(states.map((s) => [s.name, s.states.map((c) => c.name)]), [['menu', ['menu-close']], ['settings', ['settings-close']]]);
  assert.deepEqual(flat(states), [['menu', null, 'mobile'], ['menu-close', 'menu', 'mobile'], ['settings', null, 'mobile'], ['settings-close', 'settings', 'mobile']]);
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
    { name: 'search', click: '#search', states: [{ name: 'search-more', form_factor: 'desktop', click: '#more' }] },
    { name: 'products', form_factor: 'desktop', click: '#mega' },
  ]);
  assert.deepEqual(flat(states), [
    ['open-the-menu', null, 'mobile'], ['account', 'open-the-menu', 'mobile'],
    ['search', null, null], ['search-more', 'search', 'desktop'],
    ['products', null, 'desktop'],
  ]);
});

test('a screen not explored finds nothing, and a state only the other found is on that screen', () => {
  assert.deepEqual(statesFrom({ mobile: null, desktop: null }), []);
  assert.deepEqual(statesFrom({ mobile: [], desktop: [] }), []);
  assert.deepEqual(statesFrom({ mobile: [MENU], desktop: null }), [
    { name: 'menu', form_factor: 'mobile', click: '#menu', wait_for: '#menu[aria-expanded="true"]' },
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

// A drawer's close button a phone alone shows would fail, clicked on a
// desktop, every check that closes the drawer there.
test('what closes a state is kept only when every screen that reached it found the same', () => {
  const on = (close) => ({ ...MENU, ...(close ? { close } : {}) });
  const close = (mobile, desktop) => statesFrom({ mobile: [on(mobile)], desktop: desktop === undefined ? null : [on(desktop)] })[0].close;
  assert.equal(close('#menu-close', '#menu-close'), '#menu-close');
  assert.equal(close('#menu-close', null), undefined);
  assert.equal(close(null, '#menu-close'), undefined);
  assert.equal(close('#menu-close', '#nav-close'), undefined);
  // On one screen only, it is that screen's to say.
  assert.equal(close('#menu-close', undefined), '#menu-close');
  const [state] = statesFrom({ mobile: [on('#menu-close')], desktop: [on('#menu-close')] });
  assert.deepEqual(Object.keys(state), ['name', 'click', 'wait_for', 'close']);
  assert.match(renderStatesFile([state]), /    wait_for: '#menu\[aria-expanded="true"\]'\n    close: '#menu-close'\n/);
});

test('a found state takes no name already taken, in the tree or by the project', () => {
  const states = statesFrom(
    { mobile: [node(1, null, '#a', 'Menu'), node(2, null, '#b', 'Menu'), node(3, null, '#c', ''), node(4, 1, '#d', 'Menu')], desktop: null },
    { taken: ['menu', 'button'] },
  );
  assert.deepEqual(stateNames(states), ['menu-2', 'menu-2-menu', 'menu-3', 'button-2']);
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
    ['menu', null, 'mobile'], ['sign-up', 'menu', 'mobile'], ['sign-up-terms', 'sign-up', 'mobile'],
    ['settings', null, null], ['privacy', 'settings', null], ['settings-other', 'settings', 'desktop'], ['settings-other-deeper', 'settings-other', 'desktop'],
  ]);
});

test('every name in a tree, parents before their children, and none in what is not one', () => {
  assert.deepEqual(stateNames([{ name: 'a', states: [{ name: 'b', states: [{ name: 'c' }] }] }, { name: 'd' }]), ['a', 'b', 'c', 'd']);
  assert.deepEqual(stateNames(undefined), []);
  assert.deepEqual(stateNames('states'), []);
  assert.deepEqual(stateNames([null, { click: '#x' }]), []);
});

// ── how many ──

test('over the cap, the states kept are the top-level ones first, each level in the order found, never a child without its parent', () => {
  const mobile = [
    node(1, null, '#a', 'Alpha one'), node(2, null, '#b', 'Bravo one'),
    node(3, 1, '#a1', 'Alpha child'), node(4, 2, '#b1', 'Bravo child'), node(5, 3, '#a2', 'Alpha grandchild'),
  ];
  const desktop = [node(1, null, '#a', 'Alpha one'), node(9, null, '#c', 'Charlie one')];
  const { states, left } = discovered({ mobile, desktop }, { max: 4 });
  assert.deepEqual(flat(states), [
    ['alpha-one', null, null], ['alpha-child', 'alpha-one', 'mobile'],
    ['bravo-one', null, 'mobile'],
    ['charlie-one', null, 'desktop'],
  ]);
  assert.deepEqual(left, [
    { role: 'button', name: 'Bravo child', click: '#b1', depth: 2, on: ['mobile'] },
    { role: 'button', name: 'Alpha grandchild', click: '#a2', depth: 3, on: ['mobile'] },
  ]);
  // A state on both screens counts once, as the file holds it.
  assert.equal(discovered({ mobile, desktop }, { max: 6 }).left.length, 0);
  assert.deepEqual(discovered({ mobile, desktop }).left, []);
});

// A name is handed out once the cap has done its work: none is numbered, or
// qualified, after a state the file does not hold.
test('the names of the states kept owe nothing to the ones left out', () => {
  const mobile = [node(1, null, '#a', 'Account settings'), node(2, 1, '#x', 'Close'), node(3, null, '#b', 'Billing'), node(4, 3, '#y', 'Close')];
  assert.deepEqual(stateNames(discovered({ mobile, desktop: null }, { max: 3 }).states), ['account-settings', 'account-settings-close', 'billing']);
  assert.deepEqual(stateNames(discovered({ mobile: [node(1, null, '#a', 'Help'), node(2, null, '#b', 'Help')], desktop: null }, { max: 1 }).states), ['help']);
});

test('twenty states are kept unless told otherwise', () => {
  assert.equal(MAX_STATES, 20);
});

test('an audit through the states is timed by the screen with the more of them', () => {
  const states = [
    { name: 'a', click: '#a', states: [{ name: 'b', click: '#b' }, { name: 'c', form_factor: 'desktop', click: '#c' }] },
    { name: 'd', form_factor: 'mobile', click: '#d', states: [{ name: 'e', click: '#e' }] },
  ];
  // Mobile goes through a, b, d and e; desktop through a, b and c.
  assert.equal(auditSeconds(states), 15 + 15 * 4);
  assert.equal(auditSeconds([]), 15);
  // The project's own states are gone through too.
  assert.equal(auditSeconds(states, [{ name: 'f', formFactor: 'desktop' }, { name: 'g', formFactor: null }]), 15 + 15 * 5);
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
