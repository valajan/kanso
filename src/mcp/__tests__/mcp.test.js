import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { SCREENSHOT } from '../../core/audit.js';
import { runMcpServer } from '../index.js';
import { LATEST_PROTOCOL_VERSION } from '../protocol.js';

const GOOD = { performance: 96, lcp: 1500, tbt: 80, cls: 0.01, fcp: 800 };
const POOR = { performance: 40, lcp: 6000, tbt: 900, cls: 0.4, fcp: 4000 };

// --- the harness ------------------------------------------------------------

// Collects the frames the server writes, parsed back — so the assertions read
// as the JSON-RPC a host receives, one message per line.
function collect() {
  const messages = [];
  return {
    messages,
    write(text) {
      assert.ok(text.endsWith('\n'), 'every frame ends its line');
      messages.push(JSON.parse(text));
      return true;
    },
  };
}

function fakeRunner(byUrl) {
  const calls = [];
  const run = async (url, options) => {
    calls.push({ url, ...options });
    const page = byUrl[url];
    if (page === undefined) throw new Error(`unexpected audit target ${url}`);
    if (page instanceof Error) throw page;
    return Object.fromEntries(options.modules.map((mod) => [mod.id, page[mod.id] ?? null]));
  };
  run.calls = calls;
  return run;
}

// A page's accessibility findings, as the accessibility module extracts them.
function findings(...rules) {
  return { findings: rules.map(([rule, impact, count = 1]) => ({
    rule, impact, count, title: `${rule} is broken`,
    nodes: Array.from({ length: count }, (_, i) => ({
      selector: `p.${rule}-${i}`, snippet: '<p>', label: `text ${i}`,
      explanation: 'Fix any of the following:\n  Element has insufficient color contrast of 3.1',
    })),
  })) };
}

// An empty directory: no .kanso.yml, so the audit uses Kanso's own defaults.
function emptyProject() {
  return mkdtempSync(join(tmpdir(), 'kanso-mcp-'));
}

const noRunner = async () => assert.fail('must not audit');

// Feeds the server a conversation and returns everything it said back.
async function session(requests, { runLighthouse = noRunner, cwd = emptyProject() } = {}) {
  const input = new PassThrough();
  const output = collect();
  const served = runMcpServer({ input, output, cwd, runLighthouse });

  for (const request of requests) input.write(JSON.stringify(request) + '\n');
  input.end();
  await served;

  return output.messages;
}

function call(id, name, args, meta) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } };
}

// --- the handshake ----------------------------------------------------------

test('announces its protocol version, its capabilities and its tools', async () => {
  const messages = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);

  assert.equal(messages.length, 2, 'a notification is answered by silence');

  const initialized = messages[0].result;
  assert.equal(initialized.protocolVersion, '2025-06-18', 'a version Kanso speaks is echoed back');
  assert.deepEqual(initialized.capabilities, { tools: { listChanged: false } });
  assert.equal(initialized.serverInfo.name, 'kanso');
  assert.match(initialized.serverInfo.version, /^\d+\.\d+\.\d+$/);
  assert.match(initialized.instructions, /baseline/);

  const tools = messages[1].result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ['audit_page', 'list_modules']);
  assert.equal(tools[0].inputSchema.required, undefined, 'a project with a serve: block needs no url');
  // It may run the command a project serves itself with, which no read-only
  // hint should vouch for.
  assert.equal(tools[0].annotations.readOnlyHint, false);
  assert.equal(tools[1].annotations.readOnlyHint, true);
  assert.equal(tools[0].run, undefined, 'the handler is the server\'s business, not the host\'s');
});

test('a protocol version Kanso does not know is answered with the one it speaks', async () => {
  const [message] = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ]);

  assert.equal(message.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

// --- auditing ---------------------------------------------------------------

// A JPEG data URI as Lighthouse's final screenshot carries one.
const JPEG = (label) => `data:image/jpeg;base64,${Buffer.from(label).toString('base64')}`;

// Answers like fakeRunner, with a screenshot when one is asked for — or, for a
// form factor listed in `without`, none.
function screenshotRunner(page, { without = [] } = {}) {
  const run = fakeRunner({ [page]: { performance: GOOD } });
  const wrapped = async (url, options) => {
    const data = await run(url, options);
    if (options.screenshot && !without.includes(options.formFactor)) data[SCREENSHOT] = JPEG(`${options.formFactor} pixels`);
    return data;
  };
  wrapped.calls = run.calls;
  return wrapped;
}

test('with screenshot, the page comes back as one image per form factor, after the facts and out of them', async () => {
  const runLighthouse = screenshotRunner('http://localhost:4173/');

  const [message] = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'http://localhost:4173', screenshot: true }),
  ], { runLighthouse });

  const [facts, ...rest] = message.result.content;
  assert.equal(JSON.parse(facts.text).conclusion, 'pass');
  assert.equal(message.result.structuredContent.screenshots, undefined, 'images are not facts to read');
  assert.doesNotMatch(facts.text, /base64/);
  assert.deepEqual(rest, [
    { type: 'text', text: 'The page on mobile, as its load ended:' },
    { type: 'image', data: Buffer.from('mobile pixels').toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: 'The page on desktop, as its load ended:' },
    { type: 'image', data: Buffer.from('desktop pixels').toString('base64'), mimeType: 'image/jpeg' },
  ]);
  assert.deepEqual(
    runLighthouse.calls.map((c) => [c.formFactor, c.screenshot ?? false]),
    [['mobile', true], ['desktop', true], ['mobile', false], ['desktop', false]],
    'the page under audit, never its baseline'
  );
});

test('without screenshot, nothing but the facts; a load without one is said', async () => {
  const [plain] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], {
    runLighthouse: screenshotRunner('http://localhost:4173/'),
  });
  assert.equal(plain.result.content.length, 1);

  const [partial] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', screenshot: true })], {
    runLighthouse: screenshotRunner('http://localhost:4173/', { without: ['desktop'] }),
  });
  assert.deepEqual(partial.result.content.slice(3), [{ type: 'text', text: 'No desktop screenshot: that load produced none.' }]);

  const [wrong] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', screenshot: 'yes' })]);
  assert.equal(wrong.error.code, -32602);
  assert.match(wrong.error.message, /screenshot must be true or false/);
});

test('audit_page returns the verdict, in the text block and the structured one', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });

  assert.equal(message.result.isError, false);
  const payload = message.result.structuredContent;
  assert.equal(payload.conclusion, 'pass');
  assert.equal(payload.url, 'http://localhost:4173/');
  assert.equal(payload.baseline, null);
  assert.equal(payload.runs, 1);
  assert.equal(payload.modules.performance.scores.mobile.current.lcp, 1500);
  assert.deepEqual(JSON.parse(message.result.content[0].text), payload, 'the same facts, twice');
  assert.deepEqual(runLighthouse.calls.map((c) => c.formFactor), ['mobile', 'desktop']);
});

test('a page over budget is a verdict, not an error', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: POOR } });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });

  assert.equal(message.result.isError, false, 'the tool worked; the page is the problem');
  assert.equal(message.result.structuredContent.conclusion, 'fail');
  assert.equal(message.result.structuredContent.modules.performance.levels.lcp, 'fail');
});

test('a baseline is audited too, and says what the change added', async () => {
  const inherited = findings(['color-contrast', 'serious', 3]);
  const runLighthouse = fakeRunner({
    'http://localhost:4173/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 3], ['image-alt', 'critical', 1]) },
    'https://example.com/': { performance: GOOD, accessibility: inherited },
  });

  const [message] = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'https://example.com' }),
  ], { runLighthouse });

  assert.equal(runLighthouse.calls.length, 4, 'two pages, two form factors');
  const { findings: judged } = message.result.structuredContent.modules.accessibility;
  assert.deepEqual(judged.map((f) => [f.rule, f.state, f.level]), [
    ['image-alt', 'new', 'fail'],
    ['color-contrast', 'inherited', 'pass'],
  ]);
  assert.equal(message.result.structuredContent.conclusion, 'fail');
});

// Handed five of fifty-one elements, an agent reloaded the page in Lighthouse
// for the rest. Every element goes out, with what is wrong with it.
test('a finding lists every one of its elements, and what is wrong with each', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:4173/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 12]) },
  });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });

  const [finding] = message.result.structuredContent.modules.accessibility.findings;
  assert.equal(finding.count, 12);
  assert.equal(finding.nodes.length, 12);
  assert.match(finding.nodes[11].explanation, /contrast of 3\.1/);
});

test('runs comes from the call, then from the project configuration', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'runs: 2\n');
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const [configured] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse, cwd });
  assert.equal(configured.result.structuredContent.runs, 2);
  assert.ok(runLighthouse.calls.every((c) => c.runs === 2));

  const [asked] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', runs: 3 })], { runLighthouse, cwd });
  assert.equal(asked.result.structuredContent.runs, 3);
  assert.ok(runLighthouse.calls.slice(2).every((c) => c.runs === 3));
});

test('a page that never loaded is reported as the tool failing', async () => {
  const runLighthouse = async () => { throw new Error('chrome not found'); };

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });

  assert.equal(message.result.isError, true);
  assert.equal(message.result.structuredContent.ok, false);
  assert.equal(message.result.structuredContent.conclusion, 'error');
  assert.match(message.result.content[0].text, /chrome not found/);
});

// A record is where each load's journal goes, as on the command line: the
// runner is told where, and which page it is loading, and the result lands
// beside the journals. What an earlier audit left there goes; nothing else
// does. The result says where the record is.
test('record hands each load the directory and writes the result beside the journals', async () => {
  const cwd = emptyProject();
  const dir = join(cwd, 'rec');
  mkdirSync(dir);
  writeFileSync(join(dir, 'current.mobile.3.jsonl'), '{}\n');
  writeFileSync(join(dir, 'notes.txt'), 'mine');
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: GOOD }, 'https://example.com/': { performance: GOOD } });

  const [message] = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'https://example.com', record: 'rec' }),
  ], { runLighthouse, cwd });

  assert.equal(message.result.isError, false);
  assert.deepEqual(
    runLighthouse.calls.map((c) => `${c.url} ${c.record.side} ${c.record.dir}`).sort(),
    [
      `http://localhost:4173/ current ${dir}`, `http://localhost:4173/ current ${dir}`,
      `https://example.com/ baseline ${dir}`, `https://example.com/ baseline ${dir}`,
    ],
  );
  const payload = message.result.structuredContent;
  assert.equal(payload.record, dir);
  assert.equal(JSON.parse(message.result.content[0].text).record, dir);
  const recorded = JSON.parse(readFileSync(join(dir, 'audit.json'), 'utf8'));
  assert.equal(recorded.url, 'http://localhost:4173/');
  assert.equal(recorded.conclusion, payload.conclusion);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.throws(() => readFileSync(join(dir, 'current.mobile.3.jsonl')));
});

test('without record, no load is asked to keep a journal; a call with a mistake leaves a record as it was', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });
  const [plain] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });
  assert.ok(runLighthouse.calls.every((c) => c.record === undefined));
  assert.equal(plain.result.structuredContent.record, undefined);

  const cwd = emptyProject();
  mkdirSync(join(cwd, 'rec'));
  writeFileSync(join(cwd, 'rec', 'audit.json'), '{}');
  const [wrong] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'nope', record: 'rec' })], { cwd });
  assert.equal(wrong.error.code, -32602);
  assert.equal(readFileSync(join(cwd, 'rec', 'audit.json'), 'utf8'), '{}');
});

test('the project configuration is what list_modules reports', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'budgets:\n  lcp: 1000\naccessibility:\n  fail_on: critical\nseo:\n  ignore: [is-crawlable]\n');

  const [message] = await session([call(1, 'list_modules', {})], { cwd });

  const payload = message.result.structuredContent;
  assert.match(payload.configSource, /\.kanso\.yml$/);
  assert.deepEqual(payload.modules.map((mod) => mod.id), ['performance', 'accessibility', 'seo', 'best-practices', 'interactions']);
  // Interactions goes into and out of each state, and reads nothing else.
  assert.deepEqual(payload.modules[4].probes.map(({ id, transitions }) => [id, transitions]), [['residues', true], ['leaks', true]]);
  assert.equal(payload.modules[0].config.budgets.lcp, 1000);
  assert.equal(payload.modules[1].config.fail_on, 'critical');
  // Accessibility asks Lighthouse for nothing: it runs axe itself.
  assert.deepEqual(payload.modules[1].lighthouseCategories, []);
  assert.deepEqual(payload.modules[1].probes.map(({ id, rules }) => [id, rules.length]), [
    ['axe', 101], ['reflow', 2], ['keyboard', 3], ['motion', 1], ['focus', 7],
  ]);
  assert.deepEqual(payload.modules[1].probes.slice(1).map(({ rules }) => rules), [
    ['reflow-scroll', 'reflow-clip'],
    ['focus-trap', 'focus-visible', 'focus-obscured'],
    ['reduced-motion'],
    ['keyboard-inoperable', 'focus-lost', 'focus-not-moved', 'focus-escapes-modal', 'escape-not-closing', 'focus-not-returned', 'revealed-unreachable'],
  ]);
  assert.deepEqual(payload.modules[1].probes.filter((probe) => probe.transitions).map(({ id }) => id), ['focus']);
  // Performance times INP itself, on the clicks the states make, and on
  // nothing else.
  assert.deepEqual(payload.modules[0].probes.map(({ id, rules, states }) => [id, rules, states]), [['inp', ['inp'], true]]);

  // A check the project configures reports what this project's configuration
  // makes of it, not what Kanso would check by default.
  writeFileSync(join(cwd, '.kanso.yml'), 'accessibility:\n  tags: [wcag2a]\n');
  const [narrowed] = await session([call(1, 'list_modules', {})], { cwd });
  const axe = narrowed.result.structuredContent.modules[1].probes[0];
  assert.equal(axe.id, 'axe');
  assert.ok(axe.rules.length < 101 && axe.rules.length > 0);
  assert.ok(!axe.rules.includes('region'));

  // The states the project declares, and which checks go through them: axe
  // reads each, focus goes into and out of each.
  assert.deepEqual(payload.states, []);
  assert.deepEqual(payload.modules[1].probes.map(({ id, states, transitions }) => [id, states, transitions]), [
    ['axe', true, false], ['reflow', false, false], ['keyboard', false, false], ['motion', false, false], ['focus', false, true],
  ]);
  writeFileSync(join(cwd, '.kanso.yml'), 'states:\n  - name: menu\n    click: "#open"\n    wait_for: "#menu"\n');
  const [declared] = await session([call(1, 'list_modules', {})], { cwd });
  assert.deepEqual(declared.result.structuredContent.states, [{ name: 'menu', click: '#open', waitFor: '#menu' }]);
  // A section the project wrote part of keeps Kanso's defaults for the rest.
  assert.deepEqual(payload.modules[2].config, { fail_on: 'serious', ignore: ['is-crawlable'] });
  assert.deepEqual(payload.modules[3].config, { fail_on: 'serious' });
});

// --- serving the build ------------------------------------------------------

// A project with its build on disk and a .kanso.yml saying where.
function builtProject(kansoYml = 'serve:\n  dir: dist\n') {
  const cwd = emptyProject();
  mkdirSync(join(cwd, 'dist'));
  writeFileSync(join(cwd, 'dist', 'index.html'), '<p>the build</p>');
  writeFileSync(join(cwd, '.kanso.yml'), kansoYml);
  return cwd;
}

// Loads what it is pointed at, the way Chrome would.
async function loading(url, { modules }) {
  assert.equal(await (await fetch(url)).text(), '<p>the build</p>');
  return Object.fromEntries(modules.map((mod) => [mod.id, mod.id === 'performance' ? GOOD : null]));
}

test('with no url, the project is served the way its serve: block says', async () => {
  const [message] = await session([call(1, 'audit_page', {})], { runLighthouse: loading, cwd: builtProject() });

  assert.equal(message.result.isError, false);
  const payload = message.result.structuredContent;
  assert.deepEqual(payload.served, { url: { dir: 'dist' } });
  assert.match(payload.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await assert.rejects(fetch(payload.url), 'stopped once the audit is done');
});

test('a directory named in the call is served too', async () => {
  const cwd = builtProject('');

  const [message] = await session([call(1, 'audit_page', { url: 'dist' })], { runLighthouse: loading, cwd });

  assert.deepEqual(message.result.structuredContent.served, { url: { dir: 'dist' } });
});

test('a project Kanso could not serve is the tool failing, saying what to do', async () => {
  const cwd = builtProject('serve:\n  dir: build\n');

  const [message] = await session([call(1, 'audit_page', {})], { cwd });

  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /there is no build directory to serve — build the project first/);
});

test('list_modules says how the project is served', async () => {
  const [message] = await session([call(1, 'list_modules', {})], { cwd: builtProject() });

  assert.deepEqual(message.result.structuredContent.serve, { dir: 'dist' });
});

// --- a call that takes a minute ---------------------------------------------

test('progress is reported to a host that asked for it, and only then', async () => {
  const runLighthouse = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const watched = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173' }, { progressToken: 'tok' }),
  ], { runLighthouse });

  assert.equal(watched[0].method, 'notifications/progress');
  assert.deepEqual(watched[0].params, { progressToken: 'tok', progress: 0, message: 'auditing…' });
  assert.equal(watched[1].id, 1, 'then the answer');

  const silent = await session([call(2, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });
  assert.deepEqual(silent.map((m) => m.id), [2]);
});

// --- mistakes ---------------------------------------------------------------

test('a call Kanso cannot make is an invalid-params error naming what is wrong', async () => {
  const cases = [
    [{ name: 'audit_page', args: {} }, /url is required: the project has no serve: block/],
    [{ name: 'audit_page', args: { url: 'not-a-url' } }, /url is neither a URL nor a directory: not-a-url/],
    [{ name: 'audit_page', args: { url: 'file:///etc/passwd' } }, /url must be http or https/],
    [{ name: 'audit_page', args: { url: 'http://a', baseline: 'nope' } }, /baseline is neither a URL nor a directory: nope/],
    [{ name: 'audit_page', args: { url: 'http://a', runs: 9 } }, /between 1 and 5/],
    [{ name: 'audit_page', args: { url: 'http://a', record: 3 } }, /record must be a directory path/],
    [{ name: 'lighthouse', args: {} }, /unknown tool: lighthouse/],
  ];

  for (const [{ name, args }, expected] of cases) {
    const [message] = await session([call(1, name, args)]);
    assert.equal(message.error.code, -32602, name);
    assert.match(message.error.message, expected);
  }
});

test('a method Kanso does not have is an error, and ping is answered', async () => {
  const messages = await session([
    { jsonrpc: '2.0', id: 1, method: 'resources/list' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]);

  assert.equal(messages[0].error.code, -32601);
  assert.match(messages[0].error.message, /unknown method: resources\/list/);
  assert.deepEqual(messages[1].result, {});
});

test('messages are read off the stream however they are chunked', async () => {
  const input = new PassThrough();
  const output = collect();
  const served = runMcpServer({ input, output, cwd: emptyProject(), runLighthouse: noRunner });

  const ping = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  input.write(ping.slice(0, 12));
  input.write(`${ping.slice(12)}\n${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' })}\n{ not json }\n`);
  input.end();
  await served;

  // Answers come back as they are ready rather than in the order asked — which
  // is why a JSON-RPC response carries the id of what it answers.
  const parseError = output.messages.find((m) => m.id === null);
  assert.deepEqual(output.messages.map((m) => m.id).sort(), [1, 2, null]);
  assert.equal(parseError.error.code, -32700);
});
