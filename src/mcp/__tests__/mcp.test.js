import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runMcpServer } from '../index.js';
import { LATEST_PROTOCOL_VERSION } from '../protocol.js';

const GOOD = { inp: 120 };
const POOR = { inp: 900 };

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
async function session(requests, { runLoads = noRunner, checkStates, cwd = emptyProject() } = {}) {
  const input = new PassThrough();
  const output = collect();
  const served = runMcpServer({ input, output, cwd, runLoads, checkStates });

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
  assert.deepEqual(tools.map((tool) => tool.name), ['audit_page', 'check_states']);
  assert.equal(tools[0].inputSchema.required, undefined, 'a project with a serve: block needs no url');
  // It may run the command a project serves itself with, which no read-only
  // hint should vouch for.
  assert.equal(tools[0].annotations.readOnlyHint, false);
  assert.equal(tools[1].annotations.readOnlyHint, false);
  assert.deepEqual(tools[1].inputSchema.required, undefined, 'the declared states are the default');
  assert.deepEqual(Object.keys(tools[1].inputSchema.properties), ['states', 'url']);
  assert.deepEqual(tools[1].inputSchema.properties.states.items.required, ['name', 'click']);
  assert.equal(tools[0].run, undefined, 'the handler is the server\'s business, not the host\'s');
});

test('a protocol version Kanso does not know is answered with the one it speaks', async () => {
  const [message] = await session([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } },
  ]);

  assert.equal(message.result.protocolVersion, LATEST_PROTOCOL_VERSION);
});

// --- auditing ---------------------------------------------------------------

test('audit_page returns the verdict, in the text block and the structured one', async () => {
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });

  assert.equal(message.result.isError, false);
  const payload = message.result.structuredContent;
  assert.equal(payload.conclusion, 'pass');
  assert.equal(payload.url, 'http://localhost:4173/');
  assert.equal(payload.baseline, null);
  assert.equal(payload.runs, 1);
  assert.equal(payload.modules.performance.scores.mobile.current.inp, 120);
  assert.deepEqual(JSON.parse(message.result.content[0].text), payload, 'the same facts, twice');
  assert.deepEqual(runLoads.calls.map((c) => c.formFactor), ['mobile', 'desktop']);
});

test('a page over budget is a verdict, not an error', async () => {
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: POOR } });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });

  assert.equal(message.result.isError, false, 'the tool worked; the page is the problem');
  assert.equal(message.result.structuredContent.conclusion, 'fail');
  assert.equal(message.result.structuredContent.modules.performance.levels.inp, 'fail');
});

test('a baseline is audited too, and says what the change added', async () => {
  const inherited = findings(['color-contrast', 'serious', 3]);
  const runLoads = fakeRunner({
    'http://localhost:4173/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 3], ['image-alt', 'critical', 1]) },
    'https://example.com/': { performance: GOOD, accessibility: inherited },
  });

  const [message] = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'https://example.com' }),
  ], { runLoads });

  assert.equal(runLoads.calls.length, 4, 'two pages, two form factors');
  const { findings: judged } = message.result.structuredContent.modules.accessibility;
  assert.deepEqual(judged.map((f) => [f.rule, f.state, f.level]), [
    ['image-alt', 'new', 'fail'],
    ['color-contrast', 'inherited', 'pass'],
  ]);
  assert.equal(message.result.structuredContent.conclusion, 'fail');
});

// Handed five of fifty-one elements, an agent reloaded the page in another tool
// for the rest. Every element goes out, with what is wrong with it.
test('a finding lists every one of its elements, and what is wrong with each', async () => {
  const runLoads = fakeRunner({
    'http://localhost:4173/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 12]) },
  });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });

  const [finding] = message.result.structuredContent.modules.accessibility.findings;
  assert.equal(finding.count, 12);
  assert.equal(finding.nodes.length, 12);
  assert.match(finding.nodes[11].explanation, /contrast of 3\.1/);
});

test('runs comes from the call, then from the project configuration', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'runs: 2\n');
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const [configured] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads, cwd });
  assert.equal(configured.result.structuredContent.runs, 2);
  assert.ok(runLoads.calls.every((c) => c.runs === 2));

  const [asked] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', runs: 3 })], { runLoads, cwd });
  assert.equal(asked.result.structuredContent.runs, 3);
  assert.ok(runLoads.calls.slice(2).every((c) => c.runs === 3));
});

test('a page that never loaded is reported as the tool failing', async () => {
  const runLoads = async () => { throw new Error('chrome not found'); };

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });

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
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: GOOD }, 'https://example.com/': { performance: GOOD } });

  const [message] = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'https://example.com', record: 'rec' }),
  ], { runLoads, cwd });

  assert.equal(message.result.isError, false);
  assert.deepEqual(
    runLoads.calls.map((c) => `${c.url} ${c.record.side} ${c.record.dir}`).sort(),
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
  assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /<title>Kanso record<\/title>/);
  assert.equal(readFileSync(join(dir, 'notes.txt'), 'utf8'), 'mine');
  assert.throws(() => readFileSync(join(dir, 'current.mobile.3.jsonl')));
});

test('without record, no load is asked to keep a journal; a call with a mistake leaves a record as it was', async () => {
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });
  const [plain] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });
  assert.ok(runLoads.calls.every((c) => c.record === undefined));
  assert.equal(plain.result.structuredContent.record, undefined);

  const cwd = emptyProject();
  mkdirSync(join(cwd, 'rec'));
  writeFileSync(join(cwd, 'rec', 'audit.json'), '{}');
  const [wrong] = await session([call(1, 'audit_page', { url: 'http://localhost:4173', baseline: 'nope', record: 'rec' })], { cwd });
  assert.equal(wrong.error.code, -32602);
  assert.equal(readFileSync(join(cwd, 'rec', 'audit.json'), 'utf8'), '{}');
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
  const [message] = await session([call(1, 'audit_page', {})], { runLoads: loading, cwd: builtProject() });

  assert.equal(message.result.isError, false);
  const payload = message.result.structuredContent;
  assert.deepEqual(payload.served, { url: { dir: 'dist' } });
  assert.match(payload.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await assert.rejects(fetch(payload.url), 'stopped once the audit is done');
});

test('a directory named in the call is served too', async () => {
  const cwd = builtProject('');

  const [message] = await session([call(1, 'audit_page', { url: 'dist' })], { runLoads: loading, cwd });

  assert.deepEqual(message.result.structuredContent.served, { url: { dir: 'dist' } });
});

test('a project Kanso could not serve is the tool failing, saying what to do', async () => {
  const cwd = builtProject('serve:\n  dir: build\n');

  const [message] = await session([call(1, 'audit_page', {})], { cwd });

  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /there is no build directory to serve — build the project first/);
});

// --- a call that takes a minute ---------------------------------------------

test('progress is reported to a host that asked for it, and only then', async () => {
  const runLoads = fakeRunner({ 'http://localhost:4173/': { performance: GOOD } });

  const watched = await session([
    call(1, 'audit_page', { url: 'http://localhost:4173' }, { progressToken: 'tok' }),
  ], { runLoads });

  assert.equal(watched[0].method, 'notifications/progress');
  assert.deepEqual(watched[0].params, { progressToken: 'tok', progress: 0, message: 'auditing…' });
  assert.equal(watched[1].id, 1, 'then the answer');

  const silent = await session([call(2, 'audit_page', { url: 'http://localhost:4173' })], { runLoads });
  assert.deepEqual(silent.map((m) => m.id), [2]);
});

// --- checking states --------------------------------------------------------

// Answers like checkStates, from what it is handed, and remembers it.
function fakeCheck({ progress = [], fail = null } = {}) {
  const calls = [];
  const run = async (url, states, options) => {
    calls.push({ url, states, formFactors: options.formFactors });
    if (fail) throw fail;
    for (const event of progress) options.onProgress(event);
    return { url, screens: { mobile: { stable: true, drift: { appeared: [], disappeared: [] }, states: [] } }, summary: { checked: 1, reached: 0, unreached: 1, ok: false } };
  };
  run.calls = calls;
  return run;
}

const MENU = { name: 'menu', click: '#open', wait_for: '#menu', states: [{ name: 'sub', click: '#more' }] };

test('check_states replays the states it is given, and returns what checkStates found as it is', async () => {
  const checkStates = fakeCheck();

  const [message] = await session([
    call(1, 'check_states', { url: 'http://localhost:4173', states: [MENU] }),
  ], { checkStates });

  // The check ran: a state that does not hold is its answer, not the tool failing.
  assert.equal(message.result.isError, false);
  assert.equal(checkStates.calls.length, 1);
  assert.equal(checkStates.calls[0].url, 'http://localhost:4173/');
  assert.deepEqual(checkStates.calls[0].states, [
    { name: 'menu', click: '#open', waitFor: '#menu' },
    { name: 'sub', click: '#more', from: 'menu' },
  ]);
  const { configSource, elapsedMs, ...result } = message.result.structuredContent;
  assert.equal(configSource, null);
  assert.equal(typeof elapsedMs, 'number');
  assert.deepEqual(result, {
    url: 'http://localhost:4173/',
    screens: { mobile: { stable: true, drift: { appeared: [], disappeared: [] }, states: [] } },
    summary: { checked: 1, reached: 0, unreached: 1, ok: false },
  });
  assert.deepEqual(JSON.parse(message.result.content[0].text), message.result.structuredContent, 'the same facts, twice');
});

test('check_states with no states checks the ones the project declares, and serves the project', async () => {
  const cwd = builtProject('serve:\n  dir: dist\nstates:\n  - name: menu\n    click: "#open"\n');
  const checkStates = fakeCheck();

  const [message] = await session([call(1, 'check_states', {})], { checkStates, cwd });

  assert.equal(message.result.isError, false);
  assert.deepEqual(checkStates.calls[0].states, [{ name: 'menu', click: '#open' }]);
  assert.match(checkStates.calls[0].url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(message.result.structuredContent.served, { url: { dir: 'dist' } });
  await assert.rejects(fetch(checkStates.calls[0].url), 'stopped once the check is done');
});

test('check_states with nothing to check says where states come from', async () => {
  const [message] = await session([call(1, 'check_states', { url: 'http://localhost:4173' })], { checkStates: fakeCheck() });

  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /no states to check.*propose/s);
});

test('check_states reports a page it could not load as the tool failing', async () => {
  const checkStates = fakeCheck({ fail: new Error('net::ERR_CONNECTION_REFUSED') });

  const [message] = await session([
    call(1, 'check_states', { url: 'http://localhost:4173', states: [MENU] }),
  ], { checkStates });

  assert.equal(message.result.isError, true);
  assert.match(message.result.content[0].text, /could not be checked: net::ERR_CONNECTION_REFUSED/);
});

test('check_states reports each state checked to a host that asked for progress', async () => {
  const events = [
    { formFactor: 'mobile', state: 'menu', reached: true, done: 1, total: 2 },
    { formFactor: 'desktop', state: 'menu', reached: true, done: 1, total: 2 },
  ];

  const messages = await session([
    call(1, 'check_states', { url: 'http://localhost:4173', states: [{ name: 'menu', click: '#open' }] }, { progressToken: 'tok' }),
  ], { checkStates: fakeCheck({ progress: events }) });

  const heard = messages.filter((m) => m.method === 'notifications/progress').map((m) => m.params);
  assert.deepEqual(heard.map((p) => p.message), [
    'checking…', 'checked menu on mobile (1/2)', 'checked menu on desktop (2/2)',
  ]);
  const counts = heard.map((p) => p.progress);
  assert.deepEqual(counts, [...counts].sort((a, b) => a - b), 'progress only goes up');
  assert.equal(messages.at(-1).id, 1, 'then the answer');
});

test('check_states refuses states that are not valid, and a url it cannot use', async () => {
  const cases = [
    [{ states: [{ name: 'menu' }] }, /needs a click/],
    [{ states: [{ name: 'a b', click: '#x' }] }, /needs a name/],
    [{ states: [MENU, { name: 'menu', click: '#y' }] }, /taken by an earlier state/],
    [{ states: 'menu' }, /states: must be a list/],
    [{ url: 'nope', states: [MENU] }, /url is neither a URL nor a directory: nope/],
    [{ states: [MENU] }, /url is required/],
  ];

  for (const [args, expected] of cases) {
    const [message] = await session([call(1, 'check_states', args)], { checkStates: fakeCheck() });
    assert.equal(message.error.code, -32602, JSON.stringify(args));
    assert.match(message.error.message, expected);
  }
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
  const served = runMcpServer({ input, output, cwd: emptyProject(), runLoads: noRunner });

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
