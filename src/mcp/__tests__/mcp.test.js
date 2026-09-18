import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
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
    nodes: Array.from({ length: count }, (_, i) => ({ selector: `p.${rule}-${i}`, snippet: '<p>' })),
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
  assert.deepEqual(tools[0].inputSchema.required, ['url']);
  assert.equal(tools[0].annotations.readOnlyHint, true);
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

test('a finding lists a sample of its elements, and the whole count', async () => {
  const runLighthouse = fakeRunner({
    'http://localhost:4173/': { performance: GOOD, accessibility: findings(['color-contrast', 'serious', 12]) },
  });

  const [message] = await session([call(1, 'audit_page', { url: 'http://localhost:4173' })], { runLighthouse });

  const [finding] = message.result.structuredContent.modules.accessibility.findings;
  assert.equal(finding.count, 12, 'the count is what the verdict rests on');
  assert.equal(finding.nodes.length, 5, 'an agent needs a place to start, not twelve selectors');
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

test('the project configuration is what list_modules reports', async () => {
  const cwd = emptyProject();
  writeFileSync(join(cwd, '.kanso.yml'), 'budgets:\n  lcp: 1000\naccessibility:\n  fail_on: critical\n');

  const [message] = await session([call(1, 'list_modules', {})], { cwd });

  const payload = message.result.structuredContent;
  assert.match(payload.configSource, /\.kanso\.yml$/);
  assert.deepEqual(payload.modules.map((mod) => mod.id), ['performance', 'accessibility']);
  assert.equal(payload.modules[0].config.budgets.lcp, 1000);
  assert.equal(payload.modules[1].config.fail_on, 'critical');
  assert.deepEqual(payload.modules[1].lighthouseCategories, ['accessibility']);
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
    [{ name: 'audit_page', args: {} }, /url is required/],
    [{ name: 'audit_page', args: { url: 'not-a-url' } }, /url is not a valid URL/],
    [{ name: 'audit_page', args: { url: 'file:///etc/passwd' } }, /url must be http or https/],
    [{ name: 'audit_page', args: { url: 'http://a', baseline: 'nope' } }, /baseline is not a valid URL/],
    [{ name: 'audit_page', args: { url: 'http://a', runs: 9 } }, /between 1 and 5/],
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
