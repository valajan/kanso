import { parentPort, workerData } from 'node:worker_threads';
import * as chromeLauncher from 'chrome-launcher';
import puppeteer from 'puppeteer-core';
import { whenStarted } from '../process/children.js';
import { getModule } from '../modules/index.js';
import { runProbes } from '../probes/index.js';
import { Journal, journalPath, SCHEMA } from '../probes/journal.js';
import { emulate } from '../probes/screens.js';
import { version } from '../version.js';

// How long the page is given to answer before the load is called failed.
const REACH_TIMEOUT_MS = 30_000;

// One page load serves every requested module: Chrome is launched, the page is
// checked to answer, then the modules' probes run on it — `probes: 'all'`, or
// 'measures' for the ones that measure alone — and each module extracts its
// own sample from what its probes made of the page. With `record` — { dir,
// side, run } — the load keeps a journal of what its probes did
// (src/probes/journal.js), written to that directory however the load ends.
async function audit({ url, formFactor, moduleIds, config, probes = 'all', record }) {
  const modules = moduleIds.map(getModule);
  const journal = record ? new Journal() : undefined;
  journal?.log('load', { schema: SCHEMA, kanso: version(), url, side: record.side, formFactor, run: record.run, startedAt: new Date().toISOString(), probes });

  // The Launcher is built by hand rather than through chromeLauncher.launch(),
  // whose launch starts Chrome, waits for its debugging port, and — when the
  // port never opens — throws without killing the Chrome it started. That
  // Chrome then keeps this thread, and so the whole process, alive: a CI job
  // that runs every audit to the end, then never exits. Killed here in every
  // case, launch included.
  const chrome = new chromeLauncher.Launcher({
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });

  try {
    // A signal reaches the main thread only: that is where this Chrome is
    // stopped from if Kanso is, since this `finally` will not run then — told
    // as soon as it is spawned, the launch not over.
    const launching = chrome.launch();
    whenStarted(chrome, launching, (pid) => parentPort.postMessage({ chrome: pid }));
    await launching;

    const reached = await reach(chrome.port, url, formFactor);
    journal?.log('reached', reached);

    const probed = await runProbes({
      port: chrome.port, url, formFactor, modules, config,
      measuresOnly: probes === 'measures', journal,
    });

    const samples = Object.fromEntries(modules.map((m) => [m.id, m.extract({ probed: probed[m.id] ?? null })]));
    journal?.log('load-end', { ok: true });
    return { samples };
  } catch (err) {
    journal?.log('load-end', { ok: false, error: err?.message ?? String(err) });
    throw err;
  } finally {
    chrome.kill();
    if (journal) {
      try {
        journal.write(journalPath(record.dir, { side: record.side, formFactor, run: record.run }));
      } catch {
        // A journal that cannot be written costs the journal, not the audit.
      }
    }
  }
}

// Whether the page answers at all, before any probe is run on it. A page that
// cannot be loaded — nothing listening, a DNS name that resolves nowhere, a
// 404 or a 500 — would fail every probe one by one, each reported as rules
// nobody checked, and the audit would read as a page with a few gaps in it. It
// is a failed load, and fails the run.
async function reach(port, url, formFactor) {
  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  try {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await emulate(page, formFactor);
    const response = await page.goto(url, { waitUntil: 'load', timeout: REACH_TIMEOUT_MS });
    const status = response?.status() ?? null;
    if (status != null && status >= 400) throw new Error(`the page answered ${status}: ${url}`);
    const reached = { finalUrl: page.url(), status };
    await context.close();
    return reached;
  } finally {
    await browser.disconnect();
  }
}

audit(workerData).then(
  ({ samples }) => parentPort.postMessage({ ok: true, samples }),
  (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) }),
);
