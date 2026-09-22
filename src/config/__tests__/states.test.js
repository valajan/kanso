import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalConfig } from '../local-config.js';
import { InvalidStates, parseStates } from '../states.js';

test('a project that declares no state has none', () => {
  assert.deepEqual(parseStates(undefined), []);
  assert.deepEqual(parseStates(null), []);
  assert.deepEqual(parseStates([]), []);
});

test('the declared states are kept in order, with what reaches each and what says it was reached', () => {
  assert.deepEqual(parseStates([
    { name: 'menu', click: "[aria-label='Menu']", wait_for: "#menu[aria-expanded='true']" },
    { name: 'signup', click: '#signup' },
  ]), [
    { name: 'menu', click: "[aria-label='Menu']", waitFor: "#menu[aria-expanded='true']" },
    { name: 'signup', click: '#signup' },
  ]);
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
  refused([{ name: 'menu', click: '#a' }, { name: 'menu', click: '#b' }], /states\[1\]: the name menu is taken/);
});

test('a .kanso.yml whose states are wrong fails as it loads, before any page does', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'kanso-states-'));
  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n');
  assert.throws(() => loadLocalConfig({ cwd }), /\.kanso\.yml: states\[0\] \(menu\) needs a click/);

  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n    click: "#open"\n');
  assert.deepEqual(loadLocalConfig({ cwd }).config.states, [{ name: 'menu', click: '#open' }]);
});
