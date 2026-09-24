import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../local-config.js';
import { InvalidStates, parseStates, pathTo, statesOn, walkOrder } from '../states.js';

test('a project that declares no state has none', () => {
  assert.deepEqual(parseStates(undefined), []);
  assert.deepEqual(parseStates(null), []);
  assert.deepEqual(parseStates([]), []);
});

test('the declared states are kept in order, with what reaches each and what says it was reached', () => {
  assert.deepEqual(parseStates([
    { name: 'menu', click: "[aria-label='Menu']", wait_for: "#menu[aria-expanded='true']" },
    { name: 'signup', from: 'menu', click: '#signup', close: '#cancel' },
  ]), [
    { name: 'menu', click: "[aria-label='Menu']", waitFor: "#menu[aria-expanded='true']" },
    { name: 'signup', click: '#signup', from: 'menu', close: '#cancel' },
  ]);
});

// A state starts from the page as it loads unless it names the one it starts
// from: the states are a tree, and each is reached down its own branch.
const TREE = parseStates([
  { name: 'menu', click: '#menu' },
  { name: 'settings', click: '#settings' },
  { name: 'signup', from: 'menu', click: '#signup' },
  { name: 'terms', from: 'signup', click: '#terms' },
  { name: 'search', from: 'menu', click: '#search' },
]);

test('a state is reached through the ones it starts from, the first clicked first', () => {
  const path = (name) => pathTo(TREE, TREE.find((s) => s.name === name)).map((s) => s.name);
  assert.deepEqual(path('menu'), []);
  assert.deepEqual(path('settings'), []);
  assert.deepEqual(path('signup'), ['menu']);
  assert.deepEqual(path('terms'), ['menu', 'signup']);
});

// Depth first: a state is read while the page is still in the one it starts
// from, and a chain declared as a chain is walked as declared.
// A drawer only a phone's layout has: looked for on mobile only, and so is
// every state reached through it.
test('a state on one screen only takes the ones reached through it along', () => {
  const states = parseStates([
    { name: 'drawer', form_factor: 'mobile', click: '#burger' },
    { name: 'account', from: 'drawer', click: '#account' },
    { name: 'search', click: '#search' },
  ]);
  assert.deepEqual(states.map((s) => [s.name, s.formFactor ?? null]), [['drawer', 'mobile'], ['account', 'mobile'], ['search', null]]);
  assert.deepEqual(statesOn(states, 'mobile').map((s) => s.name), ['drawer', 'account', 'search']);
  assert.deepEqual(statesOn(states, 'desktop').map((s) => s.name), ['search']);
});

test('a walk takes each state before the ones that start from it, siblings as declared', () => {
  assert.deepEqual(walkOrder(TREE).map((s) => s.name), ['menu', 'signup', 'terms', 'search', 'settings']);
  const chain = parseStates([{ name: 'a', click: '#a' }, { name: 'b', from: 'a', click: '#b' }, { name: 'c', from: 'b', click: '#c' }]);
  assert.deepEqual(walkOrder(chain), chain);
});

// The runner reads the states again, in the worker, from whatever it is
// handed: reading what was already read gives the same answer.
test('states already read read the same', () => {
  const once = parseStates([{ name: 'menu', click: '#open', wait_for: '#menu' }]);
  assert.deepEqual(parseStates(once), once);
});

// A state quietly left out is a part of the page quietly left unchecked.
test('a state the file got wrong fails the configuration, naming the state', () => {
  const refused = (value, pattern) => assert.throws(() => parseStates(value), (err) => err instanceof InvalidStates && pattern.test(err.message));

  refused({ name: 'menu', click: '#open' }, /must be a list/);
  refused(['#open'], /states\[0\] must be a mapping/);
  refused([{ click: '#open' }], /states\[0\] needs a name/);
  refused([{ name: 'the menu', click: '#open' }], /needs a name/);
  refused([{ name: 'menu@2', click: '#open' }], /needs a name/);
  refused([{ name: 'menu' }], /states\[0\] \(menu\) needs a click/);
  refused([{ name: 'menu', click: '  ' }], /needs a click/);
  refused([{ name: 'menu', click: '#open', wait_for: 3 }], /wait_for must be a selector/);
  refused([{ name: 'menu', click: '#open', close: '' }], /close must be a selector/);
  refused([{ name: 'menu', click: '#a' }, { name: 'menu', click: '#b' }], /states\[1\]: the name menu is taken/);
  // `from` names a state declared before: no state is reached through itself.
  refused([{ name: 'signup', from: 'menu', click: '#signup' }, { name: 'menu', click: '#menu' }], /states\[0\] \(signup\): from must name a state declared before it/);
  refused([{ name: 'menu', from: 'menu', click: '#menu' }], /from must name a state declared before it/);
  refused([{ name: 'menu', from: 3, click: '#menu' }], /from must name a state/);
  refused([{ name: 'menu', form_factor: 'tablet', click: '#menu' }], /form_factor must be mobile or desktop/);
  refused([{ name: 'drawer', form_factor: 'mobile', click: '#a' }, { name: 'x', from: 'drawer', form_factor: 'desktop', click: '#b' }], /starts from drawer, which is only on mobile/);
});

test('a .kanso.yml whose states are wrong fails as it loads, before any page does', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kanso-states-'));
  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n');
  assert.throws(() => loadLocalConfig({ cwd }), /\.kanso\.yml: states\[0\] \(menu\) needs a click/);

  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n    click: "#open"\n');
  assert.deepEqual(loadLocalConfig({ cwd }).config.states, [{ name: 'menu', click: '#open' }]);
});
