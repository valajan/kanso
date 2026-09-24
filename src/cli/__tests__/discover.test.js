import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { main } from '../index.js';

// `kanso discover`, with the click-through stood in: what the command makes of
// what was found — printed, or written into .kanso.yml beside what the file
// already says. The click-through itself is tested against a real Chrome
// (test/discover/).

function fakeIo() {
  const io = { out: '', err: '' };
  io.stdout = { write: (s) => { io.out += s; } };
  io.stderr = { write: (s) => { io.err += s; } };
  return io;
}

function project(kansoYml) {
  const cwd = mkdtempSync(join(tmpdir(), 'kanso-discover-'));
  if (kansoYml != null) writeFileSync(join(cwd, '.kanso.yml'), kansoYml);
  return cwd;
}

// A menu on both screens, a sign-up form inside it, and a drawer only the
// phone's layout has.
const FOUND = {
  explored: {
    mobile: [
      { id: 1, parent: null, click: '#menu', waitFor: '#menu[aria-expanded="true"]', role: 'button', name: 'Menu', depth: 1 },
      { id: 2, parent: 1, click: '#signup', waitFor: null, role: 'link', name: 'Sign up', depth: 2 },
      { id: 3, parent: null, click: '#burger', waitFor: '#drawer', role: 'button', name: 'Open navigation', depth: 1 },
    ],
    desktop: [
      { id: 1, parent: null, click: '#menu', waitFor: '#menu[aria-expanded="true"]', role: 'button', name: 'Menu', depth: 1 },
      { id: 2, parent: 1, click: '#signup', waitFor: null, role: 'link', name: 'Sign up', depth: 2 },
    ],
  },
  dropped: [{ formFactor: 'desktop', id: 4, parent: null, click: '#flaky', role: 'button', name: 'Flaky', reason: 'nothing visible to click at #flaky' }],
  runs: {
    mobile: { clicks: 12, stable: true, leftInQueue: 0, outOfTime: false },
    desktop: { clicks: 9, stable: true, leftInQueue: 0, outOfTime: false },
  },
};

function fakeDiscover(found = FOUND) {
  const calls = [];
  const discover = async (url, opts) => {
    calls.push({ url, ...opts });
    return found;
  };
  discover.calls = calls;
  return discover;
}

async function run(argv, { cwd = project(), discover = fakeDiscover() } = {}) {
  const io = fakeIo();
  const code = await main(argv, { io, cwd, discover });
  return { code, cwd, ...io };
}

test('discover prints the states found as a states: block, and writes nothing', async () => {
  const cwd = project();
  const { code, out, err } = await run(['discover', 'http://localhost:3000'], { cwd });

  assert.equal(code, 0);
  const { states } = yaml.load(out);
  assert.deepEqual(states.map(({ name, from, form_factor }) => [name, from ?? null, form_factor ?? null]), [
    ['menu', null, null],
    ['sign-up', 'menu', null],
    ['open-navigation', null, 'mobile'],
  ]);
  assert.match(err, /mobile: 3 states from 12 clicks/);
  assert.match(err, /left out on desktop: button "Flaky" — it did not replay/);
  assert.match(err, /--write/);
  assert.equal(existsSync(join(cwd, '.kanso.yml')), false);
});

test('--write adds the states to .kanso.yml, keeping what the file says', async () => {
  const cwd = project('# the budgets we agreed on\nbudgets:\n  mobile:\n    lcp: 2500\n');
  const { code, err } = await run(['discover', 'http://localhost:3000', '--write'], { cwd });

  assert.equal(code, 0);
  const text = readFileSync(join(cwd, '.kanso.yml'), 'utf8');
  assert.match(text, /^# the budgets we agreed on$/m);
  const config = yaml.load(text);
  assert.deepEqual(config.budgets, { mobile: { lcp: 2500 } });
  assert.deepEqual(config.states.map(({ name }) => name), ['menu', 'sign-up', 'open-navigation']);
  assert.match(err, /wrote 3 states to \.kanso\.yml/);
});

test('a state the project already declares is kept as written, and not found again', async () => {
  const cwd = project('states:\n  - name: nav\n    click: "#menu"\n    close: "#menu-close"\n');
  await run(['discover', 'http://localhost:3000', '--write'], { cwd });

  const { states } = yaml.load(readFileSync(join(cwd, '.kanso.yml'), 'utf8'));
  assert.deepEqual(states[0], { name: 'nav', click: '#menu', close: '#menu-close' });
  // What was found inside the menu starts from the project's own name for it.
  assert.deepEqual(states.find(({ click }) => click === '#signup')?.from, 'nav');
  assert.equal(states.filter(({ click }) => click === '#menu').length, 1);
});

test('nothing new found leaves the file untouched', async () => {
  const text = 'states:\n  - name: nav\n    click: "#menu"\n';
  const cwd = project(text);
  const found = { ...FOUND, explored: { mobile: [FOUND.explored.mobile[0]], desktop: [FOUND.explored.desktop[0]] }, dropped: [] };
  const { err } = await run(['discover', 'http://localhost:3000', '--write'], { cwd, discover: fakeDiscover(found) });

  assert.equal(readFileSync(join(cwd, '.kanso.yml'), 'utf8'), text);
  assert.match(err, /nothing to add/);
});

test('the depth, the clicks and the screen are handed to the click-through', async () => {
  const discover = fakeDiscover();
  await run(['discover', 'http://localhost:3000', '--depth', '1', '--max-clicks', '20', '--form-factor', 'mobile'], { discover });

  assert.deepEqual(discover.calls.map(({ url, maxDepth, maxClicks, formFactors }) => ({ url, maxDepth, maxClicks, formFactors })), [
    { url: 'http://localhost:3000/', maxDepth: 1, maxClicks: 20, formFactors: ['mobile'] },
  ]);
});

test('--json prints what was found and nothing else', async () => {
  const { out, err } = await run(['discover', 'http://localhost:3000', '--json']);
  const result = JSON.parse(out);
  assert.deepEqual(result.added, ['menu', 'sign-up', 'open-navigation']);
  assert.equal(result.states.length, 3);
  assert.equal(err, '');
});

test('an audit option on discover, or a discover option on an audit, is a mistake', async () => {
  for (const argv of [
    ['discover', 'http://localhost:3000', '--runs', '3'],
    ['audit', 'http://localhost:3000', '--write'],
    ['discover', 'http://localhost:3000', '--depth', '9'],
    ['discover', 'http://localhost:3000', '--form-factor', 'tablet'],
    ['discover', 'a', 'b'],
  ]) {
    const { code, err } = await run(argv);
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, /kanso --help/);
  }
});

test('with no page named and no serve: block, discover says what it needs', async () => {
  const { code, err } = await run(['discover']);
  assert.equal(code, 2);
  assert.match(err, /discover needs a URL or a directory/);
});
