import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../index.js';

const GOOD = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
const POOR = { performance: 40, lcp: 6000, tbt: 900, cls: 0.4, fcp: 4000 };
const MEH  = { performance: 80, lcp: 3000, tbt: 300, cls: 0.15, fcp: 2000 };

// Collects what the command wrote, without a TTY — so no colours and no
// progress ticker, and the assertions read as the text a user sees.
function fakeIo() {
  const io = { out: '', err: '' };
  io.stdout = { write: (s) => { io.out += s; } };
  io.stderr = { write: (s) => { io.err += s; } };
  return io;
}

function fakeRunner(byUrl) {
  const calls = [];
  const run = async (url, opts) => {
    calls.push({ url, ...opts });
    const score = byUrl[url];
    if (score === undefined) throw new Error(`unexpected audit target ${url}`);
    if (score instanceof Error) throw score;
    return { performance: score };
  };
  run.calls = calls;
  return run;
}

// An empty directory: no .kanso.yml, so the run uses Kanso's own defaults.
function emptyProject() {
  return mkdtempSync(join(tmpdir(), 'kanso-cli-'));
}

async function run(argv, { runLighthouse, cwd = emptyProject() } = {}) {
  const io = fakeIo();
  const code = await main(argv, { io, cwd, runLighthouse });
  return { code, ...io };
}

test('audits a URL and reports both form factors', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD });

  const { code, out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.equal(code, 0);
  assert.match(out, /mobile/);
  assert.match(out, /desktop/);
  assert.match(out, /LCP\s+4000ms\s+1500ms/);
  assert.match(out, /pass · everything within budget/);
  assert.equal(runLighthouse.calls.length, 2);
});

test('the audit command is implied when the first argument is a URL', async () => {
  const { code } = await run(['http://localhost:3000'], { runLighthouse: fakeRunner({ 'http://localhost:3000/': GOOD }) });

  assert.equal(code, 0);
});

test('a page over budget exits 1, naming what failed', async () => {
  const { code, out } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': POOR }),
  });

  assert.equal(code, 1);
  assert.match(out, /fail · Performance, LCP, TBT, CLS, FCP/);
});

test('a warning passes by default, and fails on --fail-on warn', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': MEH });

  const lenient = await run(['audit', 'http://localhost:3000'], { runLighthouse });
  const strict = await run(['audit', 'http://localhost:3000', '--fail-on', 'warn'], { runLighthouse });

  assert.equal(lenient.code, 0);
  assert.match(lenient.out, /warn · /);
  assert.equal(strict.code, 1);
});

test('a baseline is audited too, and becomes the comparison column', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:3000/': GOOD,
    'https://example.com/': POOR,
  });

  const { code, out } = await run(
    ['audit', 'http://localhost:3000', '--baseline', 'https://example.com'],
    { runLighthouse }
  );

  assert.equal(code, 0);
  assert.equal(runLighthouse.calls.length, 4);
  assert.match(out, /against https:\/\/example\.com\//);
  assert.match(out, /baseline\s+current/);
  assert.match(out, /LCP\s+6000ms\s+1500ms\s+-4500ms/);
});

test('--json prints the result and nothing else', async () => {
  const { code, out } = await run(['audit', 'http://localhost:3000', '--json'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': POOR }),
  });

  assert.equal(code, 1);
  const parsed = JSON.parse(out);
  assert.equal(parsed.url, 'http://localhost:3000/');
  assert.equal(parsed.conclusion, 'fail');
  assert.equal(parsed.modules.performance.scores.mobile.current.lcp, 6000);
});

test('a .kanso.yml in the project is picked up', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'runs: 3\nbudgets:\n  lcp: 1000\n');
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD });

  const { code, out, err } = await run(['audit', 'http://localhost:3000'], { runLighthouse, cwd });

  assert.equal(code, 1, 'LCP 1500ms is over the 1000ms budget the file sets');
  assert.ok(runLighthouse.calls.every((c) => c.runs === 3));
  assert.match(out, /3 runs per page/);
  assert.match(err, /\.kanso\.yml/);
});

test('--runs overrides the configured run count', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'runs: 3\n');
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD });

  await run(['audit', 'http://localhost:3000', '--runs', '2'], { runLighthouse, cwd });

  assert.ok(runLighthouse.calls.every((c) => c.runs === 2));
});

test('an audit that could not run exits 2 with the reason', async () => {
  const { code, out } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: async () => { throw new Error('chrome not found'); },
  });

  assert.equal(code, 2);
  assert.match(out, /error · chrome not found/);
});

test('one form factor failing still reports the other', async () => {
  const runLighthouse = async (url, { formFactor }) => {
    if (formFactor === 'desktop') throw new Error('desktop died');
    return { performance: GOOD };
  };

  const { code, out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.equal(code, 0);
  assert.match(out, /the desktop page load failed: desktop died/);
});

// --- invocation mistakes ----------------------------------------------------

test('a mistake in the command line exits 2 and points at the help', async () => {
  const cases = [
    [[], /kanso audit <url>/],
    [['audit'], /needs a URL/],
    [['audit', 'not-a-url'], /url is not a valid URL/],
    [['audit', 'file:///etc/passwd'], /url must be http or https/],
    [['audit', 'http://a', '--runs', '9'], /between 1 and 5/],
    [['audit', 'http://a', '--fail-on', 'always'], /fail-on must be warn or fail/],
    [['audit', 'http://a', '--config', 'nope.yml'], /configuration file not found/],
    [['audit', 'http://a', '--nope'], /Unknown option/],
    [['serve', 'http://a'], /unknown command: serve/],
  ];

  for (const [argv, expected] of cases) {
    const runLighthouse = async () => assert.fail(`must not audit for ${argv.join(' ')}`);
    const { code, err } = await run(argv, { runLighthouse });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, expected, argv.join(' '));
  }
});

test('--help and --version are answered without auditing', async () => {
  const runLighthouse = async () => assert.fail('must not audit');

  const help = await run(['--help'], { runLighthouse });
  const version = await run(['--version'], { runLighthouse });

  assert.equal(help.code, 0);
  assert.match(help.out, /kanso audit <url>/);
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+$/m);
});
