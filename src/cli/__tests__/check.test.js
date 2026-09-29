import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../index.js';
import { renderCheck } from '../render.js';

// `kanso discover --check`, with the replay stood in: where the states come
// from, what the command hands the check, what it makes of the result — an
// exit code, and lines a person can act on. The replay itself is tested
// against a real Chrome (test/discover/check.test.mjs).

function fakeIo() {
  const io = { out: '', err: '' };
  io.stdout = { write: (s) => { io.out += s; } };
  io.stderr = { write: (s) => { io.err += s; } };
  return io;
}

function project(kansoYml, generatedYml) {
  const cwd = mkdtempSync(join(tmpdir(), 'kanso-check-'));
  if (kansoYml != null) writeFileSync(join(cwd, '.kanso.yml'), kansoYml);
  if (generatedYml != null) {
    mkdirSync(join(cwd, '.kanso'));
    writeFileSync(join(cwd, '.kanso', 'states.yml'), generatedYml);
  }
  return cwd;
}

const DECLARED = `states:
  - name: menu
    click: "#menu"
    states:
      - name: signup
        click: "#signup"
  - name: drawer
    form_factor: mobile
    click: "#drawer"
`;

const state = (name, extra = {}) => ({
  name, from: null, path: [], reached: true, changed: true, duplicates: null,
  click: { selector: `#${name}`, matches: 1, visible: 1 }, ...extra,
});

const summaryOf = (over = {}) => ({
  checked: 3, reached: 3, unreached: 0, unchanged: 0, duplicates: 0, closesParent: 0, closeBroken: 0,
  ambiguous: 0, waitsForNothing: 0, ok: true, ...over,
});

const resultOf = (states, summary = summaryOf()) => ({
  url: 'http://localhost:3000/',
  screens: { mobile: { stable: true, drift: { appeared: [], disappeared: [] }, states } },
  summary,
});

function fakeCheck(result = resultOf([state('menu')])) {
  const calls = [];
  const check = async (url, states, opts) => {
    calls.push({ url, states, ...opts });
    if (result instanceof Error) throw result;
    return result;
  };
  check.calls = calls;
  return check;
}

async function run(argv, { cwd = project(DECLARED), check = fakeCheck() } = {}) {
  const io = fakeIo();
  const code = await main(argv, { io, cwd, check });
  return { code, cwd, ...io };
}

test('the check gets the URL and the states an audit goes through, in the shape it reads them', async () => {
  const check = fakeCheck();
  const { code } = await run(['discover', 'http://localhost:3000', '--check'], { check });
  assert.equal(code, 0);
  assert.equal(check.calls.length, 1);
  assert.equal(check.calls[0].url, 'http://localhost:3000/');
  assert.deepEqual(check.calls[0].states, [
    { name: 'menu', click: '#menu' },
    { name: 'signup', click: '#signup', from: 'menu' },
    { name: 'drawer', click: '#drawer', formFactor: 'mobile' },
  ]);
  assert.equal(typeof check.calls[0].onProgress, 'function');
});

test('the states kanso discover --write found are checked with the project\'s own', async () => {
  const cwd = project(DECLARED, 'states:\n  - name: filters\n    click: "#filters"\n');
  const check = fakeCheck();
  await run(['discover', 'http://localhost:3000', '--check'], { cwd, check });
  assert.deepEqual(check.calls[0].states.map((s) => s.name), ['menu', 'signup', 'drawer', 'filters']);
  assert.equal(check.calls[0].states.at(-1).generated, true);
});

test('--config is honoured, and --form-factor narrows the check to one screen', async () => {
  const cwd = project(null);
  writeFileSync(join(cwd, 'other.yml'), 'states:\n  - name: only\n    click: "#only"\n');
  const check = fakeCheck();
  const { code, err } = await run(['discover', 'http://localhost:3000', '--check', '--config', 'other.yml', '--form-factor', 'desktop'], { cwd, check });
  assert.equal(code, 0);
  assert.deepEqual(check.calls[0].states.map((s) => s.name), ['only']);
  assert.deepEqual(check.calls[0].formFactors, ['desktop']);
  assert.match(err, /using .*other\.yml/);
});

test('without a page named, the serve: block says what to check', async () => {
  const cwd = project(`serve:\n  dir: dist\n${DECLARED}`);
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'index.html'), '<!doctype html><title>x</title>');
  const check = fakeCheck();
  const { code } = await run(['discover', '--check'], { cwd, check });
  assert.equal(code, 0);
  assert.match(check.calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\//);
});

test('exit 0 when every state holds, 1 when one does not, and the terminal says which', async () => {
  const ok = await run(['discover', 'http://localhost:3000', '--check']);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /pass · 3 states checked, all hold/);

  const bad = fakeCheck(resultOf(
    [state('menu', { reached: false, step: 'click', reason: 'nothing visible to click' })],
    summaryOf({ checked: 1, reached: 0, unreached: 1, ok: false }),
  ));
  const failed = await run(['discover', 'http://localhost:3000', '--check'], { check: bad });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /✗ menu/);
  assert.match(failed.out, /click: nothing visible to click/);
  assert.match(failed.out, /fail · 1 state checked: 1 not reached/);
});

test('warnings alone leave the exit code at 0', async () => {
  const check = fakeCheck(resultOf(
    [state('twins', { click: { selector: '.twin', matches: 2, visible: 2, steadiest: { selector: '#twin-a' } } })],
    summaryOf({ checked: 1, reached: 1, ambiguous: 1 }),
  ));
  const { code, out } = await run(['discover', 'http://localhost:3000', '--check'], { check });
  assert.equal(code, 0);
  assert.match(out, /! twins/);
  assert.match(out, /pass · .*1 ambiguous selector/);
});

test('no states declared is a check that could not run, and says where to get some', async () => {
  const check = fakeCheck();
  const { code, err, out } = await run(['discover', 'http://localhost:3000', '--check'], { cwd: project('runs: 1\n'), check });
  assert.equal(code, 2);
  assert.match(err, /no states declared/);
  assert.match(err, /kanso discover --write/);
  assert.equal(out, '');
  assert.equal(check.calls.length, 0);
});

test('a check that throws, or a bad configuration, could not run: exit 2', async () => {
  const thrown = await run(['discover', 'http://localhost:3000', '--check'], { check: fakeCheck(new Error('net::ERR_CONNECTION_REFUSED')) });
  assert.equal(thrown.code, 2);
  assert.match(thrown.err, /ERR_CONNECTION_REFUSED/);
  assert.equal(thrown.out, '');

  const bad = await run(['discover', 'http://localhost:3000', '--check'], { cwd: project('states:\n  - name: x\n') });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /click/);
});

test('--json prints the result and nothing else', async () => {
  const result = resultOf([state('menu')]);
  const { code, out, err } = await run(['discover', 'http://localhost:3000', '--check', '--json'], { check: fakeCheck(result) });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), result);
  assert.equal(err, '');
});

test('--check refuses what shapes an exploration', async () => {
  for (const extra of [['--write'], ['--max-states', '5'], ['--depth', '1'], ['--max-clicks', '10']]) {
    const check = fakeCheck();
    const { code, err } = await run(['discover', 'http://localhost:3000', '--check', ...extra], { check });
    assert.equal(code, 2, extra.join(' '));
    assert.match(err, /--check takes no/);
    assert.match(err, /kanso --help/);
    assert.equal(check.calls.length, 0);
  }
});

test('--check is discover\'s alone', async () => {
  for (const argv of [['audit', 'http://localhost:3000', '--check'], ['mcp', '--check']]) {
    const { code, err } = await run(argv);
    assert.equal(code, 2);
    assert.match(err, /--check is discover's/);
  }
});

test('each kind of problem reads in words, under the state it is about', () => {
  const text = renderCheck(resultOf([
    state('menu'),
    state('products', { from: 'menu', path: ['menu'], duplicates: 'menu' }),
    state('late', { reached: false, step: 'wait_for', reason: 'waiting for #never timed out' }),
    state('under-late', { reached: false, step: 'path', through: 'late', reason: 'reached through late, which was not reached', path: ['late'] }),
    state('nothing', { changed: false }),
    state('signin-x', { closesParent: 'signin', path: ['signin'] }),
    state('filters', { close: { selector: '#done', matches: 1, closed: false, reason: 'clicked, and the page is not back where the state started' } }),
    state('twins', { click: { selector: '.twin', matches: 2, visible: 2, steadiest: { selector: '#twin-a' } }, waitFor: { selector: '#twin-panel p', matchesBefore: 1, matches: 1 } }),
  ], summaryOf({ checked: 8, reached: 6, unreached: 2, unchanged: 1, duplicates: 1, closesParent: 1, closeBroken: 1, ambiguous: 1, waitsForNothing: 1, ok: false })));

  assert.match(text, /^\s*Kanso · http:\/\/localhost:3000\//);
  assert.match(text, /\n {2}✓ menu\n/);
  assert.match(text, /\n {4}✗ products\n {8}duplicates menu/);
  assert.match(text, /wait_for: waiting for #never timed out/);
  assert.match(text, /path: reached through late, which was not reached/);
  assert.match(text, /\n {4}✗ under-late/);
  assert.match(text, /changes nothing/);
  assert.match(text, /closes its parent signin — declare it as signin's close:/);
  assert.match(text, /close: does not close \(clicked, and the page is not back/);
  assert.match(text, /selector matches 2 elements, the first is clicked — #twin-a finds it alone/);
  assert.match(text, /wait_for already there before the click/);
  assert.match(text, /fail · 8 states checked: 2 not reached, 1 changing nothing, 1 duplicating another, 1 closing its parent, 1 with a close: that does not close · 1 ambiguous selector, 1 wait_for waiting for nothing/);
  assert.ok(!text.includes('\x1b['));
});

test('on a terminal the marks are coloured, and off one they are not', () => {
  const result = resultOf([state('menu')]);
  assert.match(renderCheck(result, { color: true }), /\x1b\[32m✓\x1b\[0m menu/);
  assert.ok(!renderCheck(result).includes('\x1b['));
});
