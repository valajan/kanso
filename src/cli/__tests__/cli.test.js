import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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

// What Lighthouse found behind a metric, as the performance module reports it.
const DIAGNOSTICS = {
  lcp: {
    element: { selector: 'body > img', snippet: '<img src="/hero.png">', label: 'body > img' },
    observedMs: 32,
    subparts: { timeToFirstByte: 2, resourceLoadDelay: 4, resourceLoadDuration: 7, elementRenderDelay: 19 },
  },
  renderBlocking: [{ url: 'http://localhost:3000/style.css', totalBytes: 314, wastedMs: 152 }],
  cls: { score: 0.365, shifts: [{
    element: { selector: 'main', snippet: '<main>', label: '' },
    score: 0.365,
    causes: [{ cause: 'Web font', url: 'http://localhost:3000/font.woff2' }],
  }] },
};

test('a metric that did not pass is explained, and one that passed is not', async () => {
  const { out } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': { ...POOR, diagnostics: DIAGNOSTICS } }),
  });

  assert.match(out, /LCP element\s+body > img {2}<img src="\/hero\.png">/);
  assert.match(out, /LCP, observed\s+32ms = 2ms to first byte \+ 4ms load delay \+ 7ms load duration \+ 19ms render delay/);
  assert.match(out, /render-blocking\s+http:\/\/localhost:3000\/style\.css {2}152ms/);
  assert.match(out, /layout shifts\s+main {2}0\.365 {2}Web font: http:\/\/localhost:3000\/font\.woff2/);

  const { out: clean } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': { ...GOOD, diagnostics: DIAGNOSTICS } }),
  });
  assert.doesNotMatch(clean, /LCP element|render-blocking|layout shifts/);
});

// INP is timed on the clicks the project declares. Without any, the table
// says it was not measured — a dash and no level, never a green 0ms.
test('an INP nobody measured says so, and why', async () => {
  const { code, out } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': { ...GOOD, inp: null, diagnostics: { inp: null } } }),
  });

  assert.equal(code, 0);
  assert.match(out, /INP\s+500ms\s+—\s+—\s+not measured/);
  assert.equal(out.match(/INP not measured: no states declared in \.kanso\.yml/g).length, 1, 'said once, not per form factor');
});

test('an INP over budget names the click, and where its time went', async () => {
  const interaction = {
    type: 'click', at: 'menu', latency: 640, inputDelay: 12, processing: 600, presentation: 28,
    target: { selector: 'header > button#open', snippet: '<button id="open">', label: 'Menu' },
  };
  const { code, out } = await run(['audit', 'http://localhost:3000'], {
    runLighthouse: fakeRunner({ 'http://localhost:3000/': {
      ...GOOD, inp: 640,
      diagnostics: { inp: { interaction, count: 2, failures: [{ at: 'signup', error: 'nothing visible to click at #signup' }] } },
    } }),
  });

  assert.equal(code, 1);
  assert.match(out, /INP\s+500ms\s+640ms\s+\+140ms\s+fail/);
  assert.match(out, /INP interaction\s+click {2}header > button#open {2}"Menu" {2}@ menu/);
  assert.match(out, /INP, parts\s+640ms = 12ms input delay \+ 600ms processing \+ 28ms presentation/);
  assert.match(out, /! signup could not be reached \(nothing visible to click at #signup\): its click is not in the INP/);
  assert.doesNotMatch(out, /no states declared/);
  assert.match(out, /fail · INP/);
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
  assert.match(out, /budget\s+baseline\s+current/);
  assert.match(out, /LCP\s+4000ms\s+6000ms\s+1500ms\s+-4500ms/);
});

// The verdict comes from the budget, the Δ from the baseline: a page no worse
// than its baseline still fails a budget both miss, and the line says which.
test('a metric equal to its baseline that fails its budget shows the budget it fails', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'budgets:\n  lcp: 1000\n');
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD, 'https://example.com/': GOOD });

  const { code, out } = await run(['audit', 'http://localhost:3000', '--baseline', 'https://example.com'], { runLighthouse, cwd });

  assert.equal(code, 1);
  assert.match(out, /LCP\s+1000ms\s+1500ms\s+1500ms\s+\+0ms\s+fail/);
  // A metric the file sets no budget for keeps Kanso's default, shown as such.
  assert.match(out, /TBT\s+600ms\s+80ms\s+80ms\s+\+0ms\s+pass/);
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


// --- findings ---------------------------------------------------------------

// A page's accessibility findings, as the accessibility module extracts them.
function findings(...rules) {
  return { findings: rules.map(([rule, impact, count = 1]) => ({
    rule, impact, count, title: `${rule} is broken`,
    nodes: Array.from({ length: count }, (_, i) => ({ selector: `p.${rule}-${i}`, snippet: '<p>' })),
  })) };
}

function auditingBoth(byUrl) {
  return async (url, { modules }) => {
    const page = byUrl[url];
    if (page === undefined) throw new Error(`unexpected audit target ${url}`);
    return Object.fromEntries(modules.map((m) => [m.id, page[m.id] ?? null]));
  };
}

test('a finding over the impact threshold fails the audit and names the elements', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': { performance: GOOD, accessibility: findings(['image-alt', 'critical', 2]) },
  });

  const { code, out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.equal(code, 1);
  assert.match(out, /Accessibility\s+fail/);
  assert.match(out, /image-alt\s+critical\s+2 elements\s+fail/);
  assert.match(out, /p\.image-alt-0/);
  assert.match(out, /failing from serious up/);
  assert.match(out, /fail · image-alt/);
});

// The whole point of the baseline: a page's existing debt is reported, and only
// what the change added is held against it.
test('a finding the baseline already has does not fail the audit', async () => {
  const inherited = findings(['color-contrast', 'serious', 3]);
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': { performance: GOOD, accessibility: inherited },
    'https://example.com/': { performance: GOOD, accessibility: inherited },
  });

  const { code, out } = await run(
    ['audit', 'http://localhost:3000', '--baseline', 'https://example.com'],
    { runLighthouse }
  );

  assert.equal(code, 0);
  assert.match(out, /color-contrast\s+serious\s+3 elements\s+inherited\s+pass/);
  assert.match(out, /1 already in the baseline · 0 fixed/);
});

test('a change that fixed every finding says so, with nothing already there to count', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': { performance: GOOD, accessibility: findings() },
    'https://example.com/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 3]) },
  });

  const { out } = await run(['audit', 'http://localhost:3000', '--baseline', 'https://example.com'], { runLighthouse });

  assert.match(out, /Accessibility\s+pass\s+no findings\s+failing from serious up · 1 fixed\n/);
});

// A missing alt is a missing alt, so it is said once; contrast ratios differ
// from one element to the next, so each gets its own.
test('what is wrong is printed once for the rule, or under each element when it differs', async () => {
  const node = (selector, explanation, label = '') => ({ selector, snippet: '<p>', label, explanation });
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': { performance: GOOD, accessibility: { findings: [
      { rule: 'image-alt', impact: 'critical', count: 2, title: 't', nodes: [
        node('img.logo', 'Fix any of the following:\n  Element does not have an alt attribute\n  Element has no title attribute'),
        node('img.hero', 'Fix any of the following:\n  Element does not have an alt attribute\n  Element has no title attribute'),
      ] },
      { rule: 'color-contrast', impact: 'serious', count: 2, title: 't', nodes: [
        node('p.muted', 'Fix any of the following:\n  Element has insufficient color contrast of 4.27', 'Ticket'),
        node('p.muted', 'Fix any of the following:\n  Element has insufficient color contrast of 3.9', 'Code'),
      ] },
    ] } },
  });

  const { out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  const lines = out.split('\n').map((line) => line.trim());
  const alt = lines.indexOf('Element does not have an alt attribute; Element has no title attribute');
  assert.deepEqual(lines.slice(alt, alt + 3), [
    'Element does not have an alt attribute; Element has no title attribute', 'img.logo', 'img.hero',
  ]);
  // Two elements sharing a selector are told apart by their text.
  const contrast = lines.indexOf('p.muted  "Ticket"');
  assert.deepEqual(lines.slice(contrast, contrast + 4), [
    'p.muted  "Ticket"', 'Element has insufficient color contrast of 4.27', 'p.muted  "Code"', 'Element has insufficient color contrast of 3.9',
  ]);
});

test('a page breaking no rule says so', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': { performance: GOOD, accessibility: findings() },
  });

  const { code, out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.equal(code, 0);
  assert.match(out, /Accessibility\s+pass/);
  assert.match(out, /no findings/);
});

// SEO and best practices print through the same findings list; what they add
// is failures that are no DOM element, and rules a project chose to ignore.
test('a failure with no element is printed by what it names, or what Lighthouse says of it', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'seo:\n  ignore: [is-crawlable]\n');
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': {
      performance: GOOD,
      seo: { findings: [{ rule: 'is-crawlable', impact: 'critical', count: 1, title: 't', nodes: [] }] },
      'best-practices': { findings: [
        { rule: 'doctype', impact: 'moderate', count: 0, title: 't', nodes: [], detail: 'Document must contain a doctype' },
        { rule: 'errors-in-console', impact: 'moderate', count: 1, title: 't', nodes: [
          { selector: '', snippet: '', label: '', explanation: 'Description: boom', url: 'http://localhost:3000/app.js:14:16' },
        ] },
      ] },
    },
  });

  const { code, out } = await run(['audit', 'http://localhost:3000'], { runLighthouse, cwd });

  assert.equal(code, 0, 'nothing here reaches serious');
  assert.match(out, /SEO\s+pass\s+no findings\s+failing from serious up · ignoring is-crawlable/);
  assert.match(out, /Best Practices\s+warn/);
  const lines = out.split('\n').map((line) => line.trim());
  const doctype = lines.findIndex((line) => line.startsWith('doctype'));
  assert.match(lines[doctype], /^doctype\s+moderate\s+warn$/, 'a rule broken as a whole has no element count');
  assert.equal(lines[doctype + 1], 'Document must contain a doctype');
  assert.match(out, /errors-in-console\s+moderate\s+1 item\s+warn/);
  assert.match(out, /Description: boom\n\s+http:\/\/localhost:3000\/app\.js:14:16/);
});

// A tag the page lacks is nowhere: it is printed by its explanation alone,
// rather than under an empty place.
test('a missing tag is printed by what is missing', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': {
      performance: GOOD,
      seo: { findings: [{ rule: 'open-graph', impact: 'minor', count: 2, title: 't', nodes: [
        { selector: '', snippet: '', label: '', explanation: 'og:description is missing' },
        { selector: 'head > meta', snippet: '<meta property="og:image" content="/og.png">', label: '', explanation: 'og:image is not an absolute URL: /og.png' },
      ] }] },
    },
  });

  const { out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.match(out, /open-graph\s+minor\s+2 items\s+warn\n\s+og:description is missing\n\s+head > meta  <meta property="og:image" content="\/og\.png">\n\s+og:image is not an absolute URL: \/og\.png\n/);
});

// A probe that did not run found nothing because it looked at nothing: the
// section says so, rather than reading as a clean page.
test('a probe that did not run is said, with the rules it left unchecked', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': {
      performance: GOOD,
      accessibility: { findings: [], probeFailures: [{ probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'], error: 'timed out after 30s' }] },
    },
  });

  const { out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.match(out, /no findings\n\n\s+failing from serious up\n\s+! reflow did not run on the mobile page \(timed out after 30s\): reflow-scroll, reflow-clip unchecked\n/);
});

// A finding made in a declared state says which; a state that could not be
// reached says so, and counts what went unchecked there rather than naming a
// hundred rules.
test('a finding made in a declared state says where, and a state not reached says so', async () => {
  const runLighthouse = auditingBoth({
    'http://localhost:3000/': {
      performance: GOOD,
      accessibility: {
        findings: [{ rule: 'button-name', at: 'menu', impact: 'critical', count: 1, title: 't', nodes: [{ selector: 'nav > button', snippet: '<button>', label: '', explanation: '' }] }],
        probeFailures: [{ probe: 'axe', at: 'signup', rules: Array.from({ length: 100 }, (_, i) => `rule-${i}`), error: 'not reached: menu could not be' }],
      },
    },
  });

  const { out } = await run(['audit', 'http://localhost:3000'], { runLighthouse });

  assert.match(out, /button-name @ menu\s+critical\s+1 element\s+fail\n/);
  assert.match(out, /! signup could not be reached on the mobile page \(not reached: menu could not be\): 100 rules unchecked there\n/);
  assert.match(out, /fail · button-name@menu/);
});

// --- serving the build ------------------------------------------------------

// A project with its build on disk, as `npm run build` leaves it.
function builtProject(kansoYml = '') {
  const cwd = emptyProject();
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'index.html'), '<p>the build</p>');
  if (kansoYml) writeFileSync(join(cwd, '.kanso.yml'), kansoYml);
  return cwd;
}

// A runner that loads what it is pointed at, the way Chrome would, and says
// what it found there.
function loadingRunner(score = GOOD) {
  const loaded = [];
  const run = async (url) => {
    loaded.push({ url, body: await (await fetch(url)).text() });
    return { performance: score };
  };
  run.loaded = loaded;
  return run;
}

test('a directory is served for the audit, named in the report, and stopped after', async () => {
  const cwd = builtProject();
  const runLighthouse = loadingRunner();

  const { code, out } = await run(['audit', 'dist'], { runLighthouse, cwd });

  assert.equal(code, 0);
  assert.equal(runLighthouse.loaded.length, 2);
  assert.ok(runLighthouse.loaded.every(({ url, body }) => url.startsWith('http://127.0.0.1:') && body === '<p>the build</p>'));
  assert.match(out, /Kanso · dist\n/, 'the directory, not the port it happened to get');
  await assert.rejects(fetch(runLighthouse.loaded[0].url), 'nothing is left serving once the audit is done');
});

test('with no page named, the serve: block of .kanso.yml says what to audit', async () => {
  const cwd = builtProject('serve:\n  dir: dist\n');
  const runLighthouse = loadingRunner();

  const { code, out } = await run(['audit', '--json'], { runLighthouse, cwd });

  assert.equal(code, 0);
  assert.ok(runLighthouse.loaded.every(({ body }) => body === '<p>the build</p>'));
  const result = JSON.parse(out);
  assert.deepEqual(result.served, { url: { dir: 'dist' } });
  assert.match(result.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('a baseline directory is served alongside, and becomes the comparison', async () => {
  const cwd = builtProject();
  mkdirSync(join(cwd, 'base'));
  writeFileSync(join(cwd, 'base', 'index.html'), '<p>before</p>');
  const scores = { '<p>the build</p>': GOOD, '<p>before</p>': POOR };
  const runLighthouse = async (url) => ({ performance: scores[await (await fetch(url)).text()] });

  const { code, out } = await run(['audit', 'dist', '--baseline', 'base'], { runLighthouse, cwd });

  assert.equal(code, 0);
  assert.match(out, /against base · /);
  assert.match(out, /LCP\s+4000ms\s+6000ms\s+1500ms\s+-4500ms/);
});

test('a serve: block Kanso cannot serve is why the audit did not run', async () => {
  const cases = [
    ['serve:\n  dir: build\n', /there is no build directory to serve — build the project first/],
    ['serve:\n  url: http://localhost:4173\n', /serve.url needs serve.command/],
  ];
  for (const [kansoYml, expected] of cases) {
    const { code, err } = await run(['audit'], { runLighthouse: async () => assert.fail('must not audit'), cwd: builtProject(kansoYml) });
    assert.equal(code, 2, kansoYml);
    assert.match(err, expected);
    assert.doesNotMatch(err, /--help/, 'a configuration mistake is not an invocation mistake');
  }
});

test('--out writes the Markdown report and the JSON, next to what the terminal shows', async () => {
  const cwd = emptyProject();
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': POOR });

  const { code, out } = await run(
    ['audit', 'http://localhost:3000', '--out', 'report.md', '-o', 'kanso/result.json'],
    { runLighthouse, cwd },
  );

  assert.equal(code, 1);
  assert.match(out, /fail · Performance/);
  const markdown = readFileSync(join(cwd, 'report.md'), 'utf8');
  assert.match(markdown, /^## Kanso \| Audit Report\n\n🔗 `http:\/\/localhost:3000\/`\n/);
  assert.match(markdown, /\| Metric \| budget \| current \| Δ \| \|/);
  assert.match(markdown, /\| LCP \| 4000ms \| 6000ms \| \+2000ms \| ❌ \|/);
  assert.doesNotMatch(markdown, /kanso:report/, 'the marker belongs to the PR comment');
  const json = JSON.parse(readFileSync(join(cwd, 'kanso', 'result.json'), 'utf8'));
  assert.equal(json.conclusion, 'fail');
});

test('--out still says what happened when the page never loaded', async () => {
  const cwd = emptyProject();

  const { code } = await run(['audit', 'http://localhost:3000', '--out', 'report.md'], {
    runLighthouse: async () => { throw new Error('CHROME_INTERSTITIAL_ERROR'); }, cwd,
  });

  assert.equal(code, 2);
  assert.match(readFileSync(join(cwd, 'report.md'), 'utf8'), /The audit could not run: `CHROME_INTERSTITIAL_ERROR`/);
});

// --- invocation mistakes ----------------------------------------------------

test('a mistake in the command line exits 2 and points at the help', async () => {
  const cases = [
    [[], /kanso audit \[url \| dir\]/],
    [['audit'], /needs a URL or a directory, or a serve: block in \.kanso\.yml/],
    [['audit', 'not-a-url'], /target is neither a URL nor a directory: not-a-url/],
    [['audit', 'file:///etc/passwd'], /target must be http or https/],
    [['audit', 'http://a', '--baseline', 'nope'], /baseline is neither a URL nor a directory: nope/],
    [['audit', 'http://a', 'http://b'], /audit takes one page, got 2/],
    [['audit', 'http://a', '--out', 'report.txt'], /--out writes a \.md or a \.json file, not report\.txt/],
    [['audit', 'http://a', '--runs', '9'], /between 1 and 5/],
    [['audit', 'http://a', '--fail-on', 'always'], /fail-on must be warn or fail/],
    [['audit', 'http://a', '--config', 'nope.yml'], /configuration file not found/],
    [['audit', 'http://a', '--nope'], /Unknown option/],
    [['serve', 'http://a'], /unknown command: serve/],
    [['mcp', 'http://a'], /mcp takes no arguments/],
    [['mcp', '--runs', '3'], /mcp takes no options/],
  ];

  for (const [argv, expected] of cases) {
    const runLighthouse = async () => assert.fail(`must not audit for ${argv.join(' ')}`);
    const { code, err } = await run(argv, { runLighthouse });
    assert.equal(code, 2, argv.join(' '));
    assert.match(err, expected, argv.join(' '));
  }
});

// A record is where each load's journal goes: the runner is told where, and
// which page it is loading, and the result lands beside the journals, with the
// page that shows them. What an earlier audit left there goes; nothing else
// does.
test('--record hands each load the directory and writes the result and its page beside the journals', async () => {
  const cwd = emptyProject();
  const dir = join(cwd, 'rec');
  mkdirSync(dir);
  writeFileSync(join(dir, 'current.mobile.3.jsonl'), '{}\n');
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD, 'https://example.com/': GOOD });

  const { code, err } = await run(['audit', 'http://localhost:3000', '--baseline', 'https://example.com', '--record', 'rec'], { runLighthouse, cwd });

  assert.equal(code, 0);
  assert.deepEqual(
    runLighthouse.calls.map((c) => `${c.url} ${c.record.side} ${c.record.dir}`).sort(),
    [
      `http://localhost:3000/ current ${dir}`, `http://localhost:3000/ current ${dir}`,
      `https://example.com/ baseline ${dir}`, `https://example.com/ baseline ${dir}`,
    ],
  );
  assert.equal(JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8')).url, 'http://localhost:3000/');
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /<title>Kanso record<\/title>/);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.throws(() => readFileSync(join(dir, 'current.mobile.3.jsonl')));
  assert.match(err, /journal kept in/);
});

test('without --record, no load is asked to keep a journal', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:3000/': GOOD });
  await run(['audit', 'http://localhost:3000'], { runLighthouse });
  assert.ok(runLighthouse.calls.every((c) => c.record === undefined));
});

// The MCP server is the third surface onto the same audit, and the command
// line is how a host starts it. Its own tests are in src/mcp/__tests__.
test('kanso mcp serves the audit on stdin and stdout', async () => {
  const io = fakeIo();
  io.stdin = new PassThrough();

  const served = main(['mcp'], { io, cwd: emptyProject(), runLighthouse: async () => assert.fail('must not audit') });
  io.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  io.stdin.end();

  assert.equal(await served, 0);
  const [message] = io.out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(message.result.tools.map((tool) => tool.name), ['audit_page', 'list_modules']);
});

test('--help and --version are answered without auditing', async () => {
  const runLighthouse = async () => assert.fail('must not audit');

  const help = await run(['--help'], { runLighthouse });
  const version = await run(['--version'], { runLighthouse });

  assert.equal(help.code, 0);
  assert.match(help.out, /kanso audit \[url \| dir\]/);
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+$/m);
});
