import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStates } from '../../config/states.js';
import { summarize, walk } from '../check.js';

// How proposed states are walked on one screen and what they come to, with
// the page stood in by what each replay would find. The replay itself is
// tested against a real Chrome (test/discover/check.test.mjs).

const STATES = parseStates([
  { name: 'menu', click: '#menu', states: [{ name: 'products', click: '#products', states: [{ name: 'anvils', click: '#anvils' }] }] },
  { name: 'drawer', form_factor: 'mobile', click: '#drawer', states: [{ name: 'drawer-sort', click: '#sort' }] },
  { name: 'signin', click: '#signin' },
  { name: 'account', click: '#account' },
  { name: 'like', click: '#like' },
]);

// A replay that finds, for each click, what `outcomes` says — reached,
// ending at the key given, by default one of its own.
function replaying(outcomes = {}) {
  const calls = [];
  const replay = async (state, path) => {
    calls.push([state.name, path.map((s) => s.name)]);
    const outcome = outcomes[state.click] ?? {};
    if (outcome.reached === false) return { reached: false, step: 'click', reason: `nothing visible to click at ${state.click}` };
    return { reached: true, changed: outcome.changed ?? true, key: outcome.key ?? state.click };
  };
  return { replay, calls };
}

test('each state is replayed down its path, in the order a walk takes them, on the screens it is on', async () => {
  const mobile = replaying();
  await walk(STATES, 'mobile', mobile.replay);
  assert.deepEqual(mobile.calls, [
    ['menu', []], ['products', ['menu']], ['anvils', ['menu', 'products']],
    ['drawer', []], ['drawer-sort', ['drawer']],
    ['signin', []], ['account', []], ['like', []],
  ]);

  const desktop = replaying();
  const out = await walk(STATES, 'desktop', desktop.replay);
  assert.deepEqual(out.map((s) => s.name), ['menu', 'products', 'anvils', 'signin', 'account', 'like']);
  assert.deepEqual(out.find((s) => s.name === 'anvils'), {
    name: 'anvils', from: 'products', path: ['menu', 'products'], reached: true, changed: true, duplicates: null,
  });
});

test('a state under one not reached is not replayed, and is not reached, through it', async () => {
  const { replay, calls } = replaying({ '#menu': { reached: false } });
  const out = await walk(STATES, 'desktop', replay);
  assert.deepEqual(calls.map(([name]) => name), ['menu', 'signin', 'account', 'like']);
  assert.deepEqual(out.slice(0, 3).map(({ name, reached, step, through }) => ({ name, reached, step, through })), [
    { name: 'menu', reached: false, step: 'click', through: undefined },
    { name: 'products', reached: false, step: 'path', through: 'menu' },
    { name: 'anvils', reached: false, step: 'path', through: 'products' },
  ]);
});

test('a state that ends where an earlier one ended duplicates it; one that changed nothing duplicates none', async () => {
  const { replay } = replaying({
    '#signin': { key: 'dialog' },
    '#account': { key: 'dialog' },
    '#like': { key: 'page', changed: false },
    '#menu': { key: 'page', changed: false },
  });
  const out = await walk(STATES, 'desktop', replay);
  const of = (name) => out.find((s) => s.name === name);
  assert.equal(of('signin').duplicates, null);
  assert.equal(of('account').duplicates, 'signin');
  assert.equal(of('like').duplicates, null);
  assert.equal(of('menu').duplicates, null);
  assert.ok(out.every((s) => !('key' in s)), 'the key tells states apart here, and is not handed out');
});

test('progress is heard once a state, with how far the screen has got', async () => {
  const heard = [];
  await walk(STATES, 'desktop', replaying({ '#menu': { reached: false } }).replay, {
    onState: (entry, done, total) => heard.push([entry.name, entry.reached, done, total]),
  });
  assert.deepEqual(heard.slice(0, 2), [['menu', false, 1, 6], ['products', false, 2, 6]]);
  assert.equal(heard.length, 6);
});

test('the summary counts every state on every screen, and is ok only when each replays, changes, stands alone and closes', () => {
  const reached = (more = {}) => ({ reached: true, changed: true, duplicates: null, click: { matches: 1 }, ...more });
  const clean = { mobile: { states: [reached(), reached({ close: { closed: true } })] }, desktop: { states: [reached()] } };
  assert.deepEqual(summarize(clean), {
    checked: 3, reached: 3, unreached: 0, unchanged: 0, duplicates: 0, closesParent: 0, closeBroken: 0, ambiguous: 0, waitsForNothing: 0, ok: true,
  });

  // An ambiguous click and a wait for nothing are counted, and replay all
  // the same.
  const warned = { mobile: { states: [reached({ click: { matches: 2 }, waitFor: { matchesBefore: 1, matches: 1 } })] } };
  assert.equal(summarize(warned).ok, true);
  assert.equal(summarize(warned).ambiguous, 1);
  assert.equal(summarize(warned).waitsForNothing, 1);

  const broken = {
    mobile: { states: [
      { reached: false, step: 'click' },
      reached({ changed: false, duplicates: null }),
      reached({ duplicates: 'signin' }),
      reached({ close: { closed: false } }),
      reached({ closesParent: 'signin' }),
    ] },
  };
  assert.deepEqual(summarize(broken), {
    checked: 5, reached: 4, unreached: 1, unchanged: 1, duplicates: 1, closesParent: 1, closeBroken: 1, ambiguous: 0, waitsForNothing: 0, ok: false,
  });
});
