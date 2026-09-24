import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatedStatesPath, loadLocalConfig } from '../local-config.js';
import { combineStates, InvalidStates, parseStates, pathTo, statesOn, walkOrder } from '../states.js';

test('a project that declares no state has none', () => {
  assert.deepEqual(parseStates(undefined), []);
  assert.deepEqual(parseStates(null), []);
  assert.deepEqual(parseStates([]), []);
});

// The states under a state are reached from it: the tree is the file's
// nesting, and a flat list, parents first, is what the checks walk.
test('the states under a state start from it, and come after it', () => {
  assert.deepEqual(parseStates([
    {
      name: 'menu',
      click: "[aria-label='Menu']",
      wait_for: "#menu[aria-expanded='true']",
      states: [{ name: 'signup', click: '#signup', close: '#cancel' }],
    },
    { name: 'settings', click: '#settings' },
  ]), [
    { name: 'menu', click: "[aria-label='Menu']", waitFor: "#menu[aria-expanded='true']" },
    { name: 'signup', click: '#signup', from: 'menu', close: '#cancel' },
    { name: 'settings', click: '#settings' },
  ]);
});

const TREE = parseStates([
  {
    name: 'menu',
    click: '#menu',
    states: [
      { name: 'signup', click: '#signup', states: [{ name: 'terms', click: '#terms' }] },
      { name: 'search', click: '#search' },
    ],
  },
  { name: 'settings', click: '#settings' },
]);

test('a state is reached through the ones above it, the first clicked first', () => {
  const path = (name) => pathTo(TREE, TREE.find((s) => s.name === name)).map((s) => s.name);
  assert.deepEqual(path('menu'), []);
  assert.deepEqual(path('settings'), []);
  assert.deepEqual(path('signup'), ['menu']);
  assert.deepEqual(path('terms'), ['menu', 'signup']);
});

// Depth first: a state is read while the page is still in the one above it.
test('a walk takes each state before the ones under it, siblings as declared', () => {
  assert.deepEqual(walkOrder(TREE).map((s) => s.name), ['menu', 'signup', 'terms', 'search', 'settings']);
});

// A drawer only a phone's layout has: looked for on mobile only, and so is
// every state under it.
test('a state on one screen only takes the ones under it along', () => {
  const states = parseStates([
    { name: 'drawer', form_factor: 'mobile', click: '#burger', states: [{ name: 'account', click: '#account' }] },
    { name: 'search', click: '#search' },
  ]);
  assert.deepEqual(states.map((s) => [s.name, s.formFactor ?? null]), [['drawer', 'mobile'], ['account', 'mobile'], ['search', null]]);
  assert.deepEqual(statesOn(states, 'mobile').map((s) => s.name), ['drawer', 'account', 'search']);
  assert.deepEqual(statesOn(states, 'desktop').map((s) => s.name), ['search']);
});

// The runner reads the states again, in the worker, from whatever it is
// handed: reading what was already read gives the same answer.
test('states already read read the same', () => {
  const once = parseStates([
    { name: 'menu', form_factor: 'mobile', click: '#open', wait_for: '#menu', states: [{ name: 'signup', click: '#signup' }] },
  ]);
  assert.deepEqual(parseStates(once), once);
  const generated = once.map((state) => ({ ...state, generated: true }));
  assert.deepEqual(parseStates(generated), generated);
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
  refused([{ name: 'menu', click: '#a', states: [{ name: 'menu', click: '#b' }] }], /states\[0\]\.states\[0\]: the name menu is taken/);
  refused([{ name: 'menu', click: '#a', states: { name: 'signup' } }], /\(menu\): states must be a list/);
  refused([{ name: 'menu', click: '#a', states: [{ name: 'signup' }] }], /states\[0\]\.states\[0\] \(signup\) needs a click/);
  refused([{ name: 'menu', click: '#a', states: [{ name: 'signup', from: 'x', click: '#b' }] }], /listed under another starts from it/);
  refused([{ name: 'menu', form_factor: 'tablet', click: '#menu' }], /form_factor must be mobile or desktop/);
  refused([{ name: 'drawer', form_factor: 'mobile', click: '#a', states: [{ name: 'x', form_factor: 'desktop', click: '#b' }] }], /reached from drawer, which is only on mobile/);
});

// --- the states found, beside the project's own ------------------------------------

const found = (tree) => parseStates(tree).map((state) => ({ ...state, generated: true }));

test('the states found come after the project\'s own, marked as found', () => {
  const states = combineStates(parseStates([{ name: 'login', click: '#login' }]), found([{ name: 'menu', click: '#menu' }]));
  assert.deepEqual(states, [{ name: 'login', click: '#login' }, { name: 'menu', click: '#menu', generated: true }]);
});

// The project named it, maybe told it how to close: its entry is the one kept,
// and what the click-through found inside it hangs from it.
test('a state found that the project declares is the project\'s, and what was found under it starts from it', () => {
  const declared = parseStates([{ name: 'nav', click: '#menu', close: '#menu-close' }]);
  const states = combineStates(declared, found([
    { name: 'menu', click: '#menu', wait_for: '#menu[aria-expanded="true"]', states: [{ name: 'signup', click: '#signup' }] },
  ]));
  assert.deepEqual(states, [
    { name: 'nav', click: '#menu', close: '#menu-close' },
    { name: 'signup', click: '#signup', from: 'nav', generated: true },
  ]);
  assert.deepEqual(walkOrder(states).map((s) => s.name), ['nav', 'signup']);
});

test('a state found under one the project keeps to the other screen is left out', () => {
  const declared = parseStates([{ name: 'nav', form_factor: 'desktop', click: '#menu' }]);
  const states = combineStates(declared, found([
    { name: 'menu', click: '#menu', states: [{ name: 'drawer', form_factor: 'mobile', click: '#drawer', states: [{ name: 'deep', click: '#deep' }] }] },
  ]));
  assert.deepEqual(states.map((s) => s.name), ['nav']);
});

test('a name found that the project has taken since asks for the file to be generated again', () => {
  assert.throws(
    () => combineStates(parseStates([{ name: 'menu', click: '#login' }]), found([{ name: 'menu', click: '#menu' }])),
    /run kanso discover --write again/,
  );
});

// --- as the files are loaded -----------------------------------------------------------

function project({ kanso, generated }) {
  const cwd = mkdtempSync(join(tmpdir(), 'kanso-states-'));
  if (kanso != null) writeFileSync(join(cwd, '.kanso.yml'), kanso);
  if (generated != null) {
    mkdirSync(join(cwd, '.kanso'));
    writeFileSync(join(cwd, '.kanso', 'states.yml'), generated);
  }
  return cwd;
}

test('a .kanso.yml whose states are wrong fails as it loads, before any page does', () => {
  const cwd = project({ kanso: 'states:\n  - name: menu\n' });
  assert.throws(() => loadLocalConfig({ cwd }), /\.kanso\.yml: states\[0\] \(menu\) needs a click/);

  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n    click: "#open"\n');
  assert.deepEqual(loadLocalConfig({ cwd }).config.states, [{ name: 'menu', click: '#open' }]);
});

test('the states kanso discover wrote are read beside the project\'s own, with or without a .kanso.yml', () => {
  const generated = 'states:\n  - name: menu\n    click: \'#menu\'\n    states:\n      - name: signup\n        click: \'#signup\'\n';
  const alone = project({ generated });
  const { config, source, statesFile } = loadLocalConfig({ cwd: alone });
  assert.equal(source, null);
  assert.equal(statesFile, generatedStatesPath(alone));
  assert.deepEqual(config.states, [
    { name: 'menu', click: '#menu', generated: true },
    { name: 'signup', click: '#signup', from: 'menu', generated: true },
  ]);

  const both = project({ kanso: 'states:\n  - name: login\n    click: "#login"\n', generated });
  assert.deepEqual(loadLocalConfig({ cwd: both }).config.states.map((s) => s.name), ['login', 'menu', 'signup']);
});

test('a generated file gone wrong fails as it loads, naming that file', () => {
  const cwd = project({ generated: 'states:\n  - name: menu\n' });
  assert.throws(() => loadLocalConfig({ cwd }), /\.kanso\/states\.yml: states\[0\] \(menu\) needs a click/);
});

test('the generated file is looked for beside the configuration named', () => {
  const cwd = project({});
  mkdirSync(join(cwd, 'conf'));
  writeFileSync(join(cwd, 'conf', 'kanso.yml'), 'runs: 1\n');
  assert.equal(loadLocalConfig({ cwd, configPath: 'conf/kanso.yml' }).statesFile, join(cwd, 'conf', '.kanso', 'states.yml'));
});
