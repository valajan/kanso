import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';

import accessibility from '../../src/modules/accessibility/index.js';
import { reflow } from '../../src/modules/accessibility/reflow.js';
import { runProbes } from '../../src/probes/index.js';
import { serveDirectory } from '../../src/serve/static.js';

// Kanso's probes, against a real Chrome, on pages whose answers are known.
//
// What runs in the page is a program of its own, sent as source: it only
// means something against a real layout engine, which `npm test` does not
// have. Each page in ./pages breaks one thing on purpose — or, for the clean
// ones, carries every pattern that looks like a failure and is not: a table
// wider than the screen, a code block with its own scrollbar, a carousel, a
// menu waiting off the screen, a visually hidden label, an ellipsis.
//
//   npm run test:probes        (needs Chrome, ~10 s)

// Lighthouse's mobile emulation, as a report's configSettings carries it.
const MOBILE = {
  formFactor: 'mobile',
  screenEmulation: { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
};

let chrome;
let site;

before(async () => {
  chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  await chrome.launch();
  site = await serveDirectory(fileURLToPath(new URL('./pages', import.meta.url)));
});

after(async () => {
  chrome?.kill();
  await site?.close();
});

function probe(page, { modules = [accessibility], formFactor = 'mobile', timeoutMs } = {}) {
  return runProbes({ port: chrome.port, url: new URL(page, site.url).href, formFactor, settings: MOBILE, modules, timeoutMs });
}

// What a finding says, in a form an assertion can hold.
function summary({ findings, failures }) {
  assert.deepEqual(failures, []);
  return findings.map((finding) => ({
    rule: finding.rule,
    count: finding.count,
    nodes: finding.nodes.map((node) => `${node.selector} — ${node.explanation}`),
  }));
}

// --- reflow -------------------------------------------------------------------------

test('a page that reflows reports nothing, whatever looks like overflow and is not', async () => {
  const { accessibility: result } = await probe('reflow-clean.html');
  assert.deepEqual(summary(result), []);
});

test('a page scrolling sideways at 320 px names the box and the text that make it', async () => {
  const { accessibility: result } = await probe('reflow-scroll.html');
  const [finding] = summary(result);

  assert.equal(finding.rule, 'reflow-scroll');
  assert.equal(finding.count, 2);
  assert.match(finding.nodes[0], /^body > main > div\.fixed-width — 400px wide, 96px past the right edge of the 320px viewport$/);
  assert.match(finding.nodes[1], /^body > main > pre\.yaml — its text runs \d+px past the right edge of the 320px viewport: “apiVersion: kanso\/v1/);
  assert.equal(result.findings[0].impact, 'serious');
});

test('text cut off by a box, or pushed past the end of a fixed bar, is lost', async () => {
  const { accessibility: result } = await probe('reflow-clip.html');
  const [finding] = summary(result);

  assert.equal(finding.rule, 'reflow-clip');
  assert.deepEqual(finding.nodes.map((node) => node.replace(/\d+px/, 'Npx')), [
    'body > header > nav > a — “Changelog” runs Npx past the right edge of the screen, out of reach',
    'body > main > div.card — cuts off “apiVersion: kanso/v1 kind: Audit budget…”, Npx past its right edge',
  ]);
  assert.equal(result.findings[0].impact, 'moderate');
});

// The usual fix for a page that scrolls sideways, which trades the scroll for
// the content.
test('a page hiding its sideways overflow does not scroll, and loses what was past the edge', async () => {
  const { accessibility: result } = await probe('reflow-hidden.html');

  assert.deepEqual(summary(result).map(({ rule, nodes }) => [rule, nodes.map((node) => node.replace(/\d+px/, 'Npx'))]), [
    ['reflow-clip', [
      'body > main > div.banner — “This banner is laid out 480 pixels wide…” runs Npx past the right edge of the screen, out of reach',
    ]],
  ]);
});

// 320 px is a width, not a device: the mobile load runs it, the desktop one
// has no probe to run.
test('reflow runs on the mobile load only', async () => {
  assert.deepEqual(await probe('reflow-scroll.html', { formFactor: 'desktop' }), {});
});

// --- the harness ----------------------------------------------------------------------

test('a probe that throws or never ends costs its own rules, and the others still run', async () => {
  const mod = {
    id: 'accessibility',
    probes: [
      { id: 'boom', rules: ['boom-rule'], run: () => { throw new Error('boom\nand a stack'); } },
      { id: 'stuck', rules: ['stuck-rule'], run: () => new Promise(() => {}) },
      reflow,
    ],
  };

  const { accessibility: result } = await probe('reflow-scroll.html', { modules: [mod], timeoutMs: 3000 });

  assert.deepEqual(result.failures, [
    { probe: 'boom', rules: ['boom-rule'], error: 'boom' },
    { probe: 'stuck', rules: ['stuck-rule'], error: 'timed out after 3s' },
  ]);
  assert.deepEqual(result.findings.map((finding) => finding.rule), ['reflow-scroll']);
});

test('a page that never answers fails every probe, with what went wrong', async () => {
  const { accessibility: result } = await runProbes({
    port: chrome.port, url: `http://127.0.0.1:${await closedPort()}/`, formFactor: 'mobile', settings: MOBILE, modules: [accessibility],
  });

  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.failures.map(({ probe, rules }) => ({ probe, rules })), [{ probe: 'reflow', rules: ['reflow-scroll', 'reflow-clip'] }]);
  assert.match(result.failures[0].error, /ERR_CONNECTION_REFUSED/);
});

// A port nothing listens on: one the system just handed out, and took back.
function closedPort() {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
