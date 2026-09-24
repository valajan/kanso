import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import * as chromeLauncher from 'chrome-launcher';
import { screenEmulationMetrics, userAgents } from 'lighthouse/core/config/constants.js';
import puppeteer from 'puppeteer-core';

import { discover } from '../../src/discover/index.js';
import { explore } from '../../src/discover/explore.js';
import { diff } from '../../src/discover/fingerprint.js';
import { load, observe, openPage, selectors, settle } from '../../src/discover/page.js';
import { axeProbe } from '../../src/modules/accessibility/axe.js';
import { runProbes } from '../../src/probes/index.js';
import { applyState } from '../../src/probes/states.js';
import { serveDirectory } from '../../src/serve/static.js';

// `kanso discover` against a real Chrome, on pages whose states are known.
//
// Each page in ./pages hides something behind a click, the way a real page
// does: a burger that is a bar on a desktop, a dialog drawn a moment after its
// button, tabs, six questions of one kind, a sort menu — and clean.html, every
// one of those patterns with nothing wrong, whose states are exactly the ones
// it has. guards.html carries everything the explorer may click and
// everything it must not; spa.html a route change that is another page,
// redirect.html an app that changes its address as it starts;
// door.html a state that opens once and never again.
//
// What is tested is the product's side: what may be clicked, how it is found
// again, which clicks are states, that a state found is one Kanso's probes
// reach — not whether a state is worth auditing, which no code here judges.
//
//   npm run test:discover      (needs Chrome, ~1 min)

let chrome;
let browser;
let site;

before(async () => {
  chrome = new chromeLauncher.Launcher({ chromeFlags: ['--headless=new', '--no-sandbox'] });
  await chrome.launch();
  browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${chrome.port}`, defaultViewport: null });
  site = await serveDirectory(fileURLToPath(new URL('./pages', import.meta.url)));
});

after(async () => {
  await browser?.disconnect();
  chrome?.kill();
  await site?.close();
});

const urlOf = (page) => new URL(page, site.url).href;

// The page as a first visit reads it, and the selector of every element it
// may click.
async function read(page, formFactor = 'mobile') {
  const url = urlOf(page);
  const tab = await openPage(browser, formFactor);
  try {
    await load(tab, url);
    const reading = await observe(tab.page);
    return { reading, selectorsOf: await selectors(tab.page, reading) };
  } finally {
    await tab.close();
  }
}

const named = (reading, name) => reading.snap.elements.find((e) => e.name === name);

// One click, from a first visit, in a guarded page: what the net stopped,
// where the page stands after, and what the click changed.
async function clickOnce(page, click, formFactor = 'mobile') {
  const url = urlOf(page);
  const tab = await openPage(browser, formFactor);
  try {
    await load(tab, url);
    const before = await observe(tab.page);
    await applyState(tab.page, { click }, { waitMs: 5_000 });
    const after = await settle(tab.page);
    return { blocked: tab.guard.blocked, url: after.snap.url, change: diff(before.print, after.print) };
  } finally {
    await tab.close();
  }
}

// An exploration is the slow part — ten to twenty seconds a page — and two
// tests may ask the same question of it.
const explorations = new Map();
function explored(page, formFactor, options = {}) {
  const key = JSON.stringify([page, formFactor, options]);
  if (!explorations.has(key)) explorations.set(key, explore(browser, formFactor, urlOf(page), options));
  return explorations.get(key);
}

// The states found, as what was clicked and where from: `Products < Menu` is
// the submenu, reached through the menu.
function tree({ nodes }) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.map((node) => [node.name, ...(node.parent == null ? [] : [byId.get(node.parent).name])].join(' < '));
}

// The `wait_for` of each state reached from the page as it loads, that the
// page as it loads already satisfies: a wait that waits for nothing, which
// replays a state that did not open as one that did.
async function waitsForNothing(page, formFactor, { nodes }) {
  const tab = await openPage(browser, formFactor);
  try {
    await load(tab, urlOf(page));
    const already = [];
    for (const { name, waitFor } of nodes.filter((node) => node.parent == null && node.waitFor)) {
      if (await tab.page.evaluate((s) => document.querySelector(s) !== null, waitFor)) already.push(`${name}: ${waitFor}`);
    }
    return already;
  } finally {
    await tab.close();
  }
}

// --- what may be clicked -------------------------------------------------------

test('what a visitor can click is listed, and what they cannot see is not', async () => {
  const { reading } = await read('guards.html');
  const names = reading.snap.elements.map((e) => e.name);

  // A card only a pointer cursor gives away, once — not again for its span.
  assert.equal(names.filter((n) => n === 'A card that opens').length, 1);
  assert.equal(named(reading, 'A card that opens').inferred, true);
  // A skip link kept in a one-pixel box, and a drawer parked off the side.
  assert.ok(!names.includes('Skip to content'));
  assert.ok(!names.includes('Pricing'));
});

test('the guards allow what opens something on the page, and refuse the rest with a reason', async () => {
  const { reading } = await read('guards.html');
  const allowed = reading.snap.elements.filter((e) => reading.allowed.has(e.index)).map((e) => e.name);
  assert.deepEqual(allowed, [
    'Open navigation', 'Show the details', 'One', 'Two', 'A card that opens', 'Jump to pricing', 'A script link',
    'Load more', 'Generated id', 'Close the banner', 'More options', 'Jump to the questions', '⎙',
    // Nothing in their markup says what they do: the net below is for them.
    'Save preferences', 'Continue', 'Help', 'Info',
  ]);

  const reason = (name) => reading.verdicts.get(named(reading, name).index).reason;
  assert.equal(reason('Join'), 'sends a form');
  assert.ok(reason('Clear'));
  assert.equal(reason('Another page'), 'goes to another page');
  assert.equal(reason('Another site'), 'leaves the site');
  assert.equal(reason('A new tab'), 'opens another tab');
  assert.equal(reason('A download'), 'downloads a file');
  assert.equal(reason('Write to us'), 'leaves the page (mailto:)');
  assert.equal(reason('Delete account'), 'named "Delete account"');
  assert.equal(reason('Disabled'), 'disabled');
  assert.equal(reason('Also disabled'), 'disabled');
  assert.match(reason('Dark mode'), /switch/);
  // A checkbox and a text field are both fields: nothing is ticked or typed.
  assert.match(reason('News'), /a field/);
  assert.match(reason('Email'), /a field/);
});

test('the net stops what no markup announces, and leaves the page where it was', async () => {
  const [write, navigation, window, dialog] = await Promise.all([
    clickOnce('guards.html', '#beacon'),
    clickOnce('guards.html', '#leave'),
    clickOnce('guards.html', '#popup'),
    clickOnce('guards.html', '#alert'),
  ]);
  assert.deepEqual(write.blocked.map((b) => [b.kind, b.method, new URL(b.url).pathname]), [['write', 'POST', '/preferences']]);
  assert.deepEqual(navigation.blocked.map((b) => [b.kind, new URL(b.url).pathname]), [['navigation', '/next.html']]);
  assert.deepEqual(window.blocked.map((b) => b.kind), ['window']);
  assert.deepEqual(dialog.blocked.map((b) => [b.kind, b.type, b.message]), [['dialog', 'alert', 'Info']]);
  // A stopped navigation is answered with nothing to show, not aborted: an
  // abort would swap the page for Chrome's error page.
  assert.equal(navigation.url, urlOf('guards.html'));
  assert.deepEqual(navigation.change, { appeared: [], disappeared: [] });
});

// --- how it is found again -----------------------------------------------------

test('every allowed element gets a selector that finds it alone, the steadiest kind first', async () => {
  const { reading, selectorsOf } = await read('guards.html');
  const of = (name) => selectorsOf.get(named(reading, name).index);
  assert.deepEqual(of('Two'), { kind: 'test-id', selector: '[data-testid="tab-two"]' });
  assert.deepEqual(of('Open navigation'), { kind: 'id', selector: '#drawer-toggle' });
  assert.deepEqual(of('Close the banner'), { kind: 'aria-label', selector: 'button[aria-label="Close the banner"]' });
  assert.deepEqual(of('More options'), { kind: 'aria-controls', selector: 'button[aria-controls="more-panel"]' });
  assert.deepEqual(of('Jump to the questions'), { kind: 'href', selector: 'a[href="#questions"]' });
  assert.deepEqual(of('⎙'), { kind: 'title', selector: 'button[title="Print this page"]' });
  // A generated id is passed over: the next build names it otherwise.
  assert.equal(of('Generated id').kind, 'css');
  assert.doesNotMatch(of('Generated id').selector, /radix/);

  // Plain CSS, every one: a state's selectors are read inside the page too,
  // by document.querySelector, which knows nothing of Puppeteer's own.
  const tab = await openPage(browser, 'mobile');
  try {
    await load(tab, urlOf('guards.html'));
    for (const [index, sel] of selectorsOf) {
      const { name } = reading.snap.elements[index];
      assert.ok(sel, `no selector for ${name}`);
      const found = await tab.page.evaluate((s) => document.querySelectorAll(s).length, sel.selector);
      assert.equal(found, 1, `${sel.selector} (${name}) finds ${found} elements`);
    }
  } finally {
    await tab.close();
  }
});

// --- which clicks are states ---------------------------------------------------

// Side by side: each click is a page of its own, and nothing here is timed.
describe('exploring, then replaying', { concurrency: 4 }, () => {
  test('the menu is found on a phone behind its burger, and the submenu two clicks deep, from the menu', async () => {
    const run = await explored('menu.html', 'mobile');
    assert.deepEqual(tree(run), ['Menu', 'Like', 'Show more', 'Products < Menu']);
    const products = run.nodes.find((node) => node.name === 'Products');
    assert.equal(products.depth, 2);
    assert.equal(products.click, '#products');
    // What says each is open is the button that opened it, expanded: the
    // links it shows were in the page all along, hidden, and a selector for
    // one of them would be satisfied before the click.
    assert.equal(run.nodes.find((node) => node.name === 'Menu').waitFor, '#burger[aria-expanded="true"]');
    assert.equal(products.waitFor, '#products[aria-expanded="true"]');
    assert.deepEqual(await waitsForNothing('menu.html', 'mobile', run), []);
    // A link to a place on the page scrolls it, and changes nothing else. The
    // menu's links are one family — the same place in each list item — and
    // only the first is tried.
    for (const name of ['Acme', 'Features']) {
      assert.equal(run.clicks.find((c) => c.name === name).outcome, 'no-change', name);
    }
    assert.equal(run.clicks.find((c) => c.name === 'Pricing'), undefined);
    assert.equal(run.stable, true);
    assert.equal(run.leftInQueue, 0);
  });

  test('on a desktop, where the navigation is always there, the submenu is one click deep', async () => {
    const run = await explored('menu.html', 'desktop');
    assert.deepEqual(tree(run), ['Products', 'Like', 'Show more']);
    // The submenu's links are one family, whatever each is called — the icon
    // link with no name among them — and the first stands for it.
    assert.deepEqual(run.clicks.filter((c) => c.from === 1).map((c) => [c.name, c.outcome]), [['Anvils', 'no-change']]);
  });

  test('a dialog drawn after its click is a state, and what it opens one click deeper is one too', async () => {
    const run = await explored('modal.html', 'desktop');
    assert.deepEqual(tree(run), ['Get the newsletter', 'Applaud', 'What will you send me? < Get the newsletter']);
    // Closing the dialog brings back the page as it loaded: a state already
    // seen, not a new one.
    assert.equal(run.clicks.find((c) => c.name === 'btn').outcome, 'repeat');
  });

  test('each tab not already chosen is a state, and the one already chosen changes nothing', async () => {
    const run = await explored('tabs.html', 'mobile');
    assert.deepEqual(tree(run), ['Specs', 'Delivery status', 'Save for later']);
    assert.equal(run.clicks.find((c) => c.from === 0 && c.name === 'Overview').outcome, 'no-change');
    // Back to the first tab from either: the page as it loaded.
    assert.deepEqual(run.clicks.filter((c) => c.from !== 0).map((c) => c.outcome), ['repeat', 'repeat']);
  });

  test('six questions of one kind are six states, since what each hides differs', async () => {
    const run = await explored('accordion.html', 'desktop');
    assert.equal(run.nodes.length, 6);
    assert.ok(run.nodes.every((node) => node.depth === 1 && node.parent == null));
    // The link inside one only jumps down the page.
    assert.equal(run.clicks.find((c) => c.name === 'click here').outcome, 'no-change');
  });

  // Twelve "Add … to the basket" buttons, each in a card of its own, are one
  // component twelve times: the first is tried, and stands for the rest. So
  // are six colour filters side by side. A toolbar's three buttons are three
  // components.
  test('the same element in each card of a list, or a row of options, is tried once; a toolbar is not', async () => {
    const run = await explored('collection.html', 'desktop');
    assert.deepEqual(tree(run), ['Filter', 'Sort', 'Share', 'Red', 'Add Anvil to the basket']);
    assert.equal(run.clicks.filter((c) => /to the basket/.test(c.name)).length, 1);
    assert.equal(run.clicks.filter((c) => ['Green', 'Blue', 'White'].includes(c.name)).length, 0);
  });

  test('a sort menu is a state, waited for by its button expanded', async () => {
    const run = await explored('listbox.html', 'mobile');
    assert.deepEqual(tree(run), ['Sort by: relevance', 'About this catalogue']);
    const [sort] = run.nodes;
    assert.equal(sort.click, '#sort');
    assert.equal(sort.waitFor, '#sort[aria-expanded="true"]');
    assert.deepEqual(await waitsForNothing('listbox.html', 'mobile', run), []);
  });

  test('the control page has exactly the states it is built with, and nothing else', async () => {
    const run = await explored('clean.html', 'mobile');
    assert.deepEqual(tree(run), [
      'Menu', 'Preview a confirmation dialog', 'Empty states', 'Where are the full guidelines?', 'Sort by: newest',
    ]);
    assert.ok(run.clicks.every((c) => c.outcome !== 'error'), JSON.stringify(run.clicks.filter((c) => c.outcome === 'error')));
    assert.deepEqual(await waitsForNothing('clean.html', 'mobile', run), []);
  });

  test('a route change a single-page app makes is another page, not a state; the same history call to a fragment is', async () => {
    const run = await explored('spa.html', 'mobile');
    assert.equal(run.clicks.find((c) => c.name === 'Account settings').outcome, 'left');
    // Nothing was stopped at the network: no load was asked for.
    assert.equal(run.clicks.find((c) => c.name === 'Account settings').blocked, undefined);
    assert.deepEqual(tree(run), ['Filters']);
  });

  // The route is judged from where the page stood before the click, not from
  // the address it was loaded from: an app that moves its root on to its
  // first screen as it starts would otherwise have every click leave it.
  test('an app that moves on to another address as it starts still has its states', async () => {
    const run = await explored('redirect.html', 'mobile');
    assert.deepEqual(tree(run), ['More']);
  });

  // --- found, then replayed ------------------------------------------------------

  test('discover explores both screens, and keeps the states that replay from a first visit', async () => {
    const heard = [];
    const result = await discover(urlOf('menu.html'), { onProgress: (event) => heard.push(event) });

    assert.deepEqual(tree({ nodes: result.explored.mobile }), ['Menu', 'Like', 'Show more', 'Products < Menu']);
    assert.deepEqual(tree({ nodes: result.explored.desktop }), ['Products', 'Like', 'Show more']);
    assert.deepEqual(result.dropped, []);
    for (const formFactor of ['mobile', 'desktop']) {
      assert.equal(result.runs[formFactor].stable, true);
      assert.equal(result.runs[formFactor].clicks, heard.filter((e) => e.formFactor === formFactor).length);
    }
  });

  // A state that opens once and never again: door.html asks the server whether
  // the door opens, and the server below says yes until the exploration's last
  // click has landed, no after. The exploration is one screen, so that the last
  // click is the last one made; its three clicks are asserted, so that a change
  // in how many it makes fails here rather than moving the moment the door
  // shuts.
  test('a state that does not come back the second time is dropped, with every state reached through it', async () => {
    const CLICKS = 3;
    let open = true;
    const server = createServer(async (req, res) => {
      const { pathname } = new URL(req.url, 'http://kanso');
      if (pathname === '/door') return res.writeHead(open ? 200 : 404, { 'content-type': 'text/plain' }).end(open ? 'open' : 'shut');
      if (pathname === '/door.html') {
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          .end(await readFile(new URL('./pages/door.html', import.meta.url)));
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      let heard = 0;
      const result = await discover(`http://127.0.0.1:${server.address().port}/door.html`, {
        formFactors: ['desktop'],
        onProgress: () => {
          if (++heard === CLICKS) open = false;
        },
      });
      assert.equal(result.runs.desktop.clicks, CLICKS);
      assert.deepEqual(tree({ nodes: result.explored.desktop }), ['About the door']);
      assert.deepEqual(result.dropped.map(({ formFactor, name, reason }) => [formFactor, name, reason.startsWith('clicked') ? 'never appeared' : reason]), [
        ['desktop', 'Open the door', 'never appeared'],
        ['desktop', 'Look inside', 'reached through a state that did not replay'],
      ]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  // Lighthouse's emulation, as a report's configSettings carries it.
  const SETTINGS = {
    formFactor: 'desktop',
    screenEmulation: screenEmulationMetrics.desktop,
    emulatedUserAgent: userAgents.desktop,
    throttling: { cpuSlowdownMultiplier: 1 },
  };

  test('the states found are reached by Kanso\'s own probes, and a fault behind two clicks is reported there', async () => {
    const run = await explored('modal.html', 'desktop');
    // As `states:` would declare them: each from the state it was found in.
    const states = run.nodes.map((node) => ({
      name: `s${node.id}`,
      click: node.click,
      ...(node.parent == null ? {} : { from: `s${node.parent}` }),
      ...(node.waitFor ? { wait_for: node.waitFor } : {}),
    }));
    const dialog = `s${run.nodes.find((node) => node.name === 'Get the newsletter').id}`;
    const details = `s${run.nodes.find((node) => node.name === 'What will you send me?').id}`;

    const { accessibility } = await runProbes({
      port: chrome.port, url: urlOf('modal.html'), formFactor: 'desktop', settings: SETTINGS,
      modules: [{ id: 'accessibility', probes: [axeProbe] }], config: { states },
    });
    assert.deepEqual(accessibility.failures, []);
    const settled = accessibility.findings.filter((f) => !f.needsReview);
    // Clean as it loads: what is wrong is behind the clicks.
    assert.deepEqual(settled.filter((f) => !f.at).map((f) => f.rule), []);
    assert.deepEqual(settled.filter((f) => f.at === dialog).map((f) => f.rule), ['aria-dialog-name']);
    assert.deepEqual(settled.filter((f) => f.at === details).map((f) => f.rule), ['image-alt']);
  });
});

// --- interrupted -----------------------------------------------------------------

// A Ctrl-C reaches Kanso, not the Chrome it started, which is in a process
// group of its own; and the `finally` that stops it does not run on a signal.
// Left running, a headless Chrome is what macOS wakes in place of the one a
// person opens (src/process/children.js).
test('a click-through interrupted leaves no Chrome behind', { skip: process.platform === 'win32' && 'process groups' }, async () => {
  const before = browsers();
  const kanso = spawn(process.execPath, [fileURLToPath(new URL('../../bin/kanso.js', import.meta.url)), 'discover', urlOf('menu.html')], { stdio: 'ignore' });
  const exited = new Promise((resolve) => kanso.once('exit', (code, signal) => resolve({ code, signal })));

  let started = [];
  for (let i = 0; i < 60 && started.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    started = browsers().filter((pid) => !before.includes(pid));
  }
  assert.ok(started.length > 0, 'no Chrome was started');

  kanso.kill('SIGINT');
  const { code, signal } = await exited;
  assert.ok(code === 130 || signal === 'SIGINT', `exited with ${code ?? signal}`);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  assert.deepEqual(browsers().filter((pid) => started.includes(pid)), []);
});

// The browsers running, by pid: the processes whose command line says
// headless, less their helpers.
function browsers() {
  return execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /--headless/.test(line) && !/--type=/.test(line) && !/\bps\b/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

