import { parentPort, workerData } from 'node:worker_threads';
import { launchChrome } from '../process/chrome.js';
import { getModule } from '../modules/index.js';
import { newPage } from '../probes/browser.js';
import { runProbes } from '../probes/index.js';
import { Journal, journalPath, SCHEMA } from '../probes/journal.js';
import { version } from '../version.js';

// How long the page is given to answer before the load is called failed.
const REACH_TIMEOUT_MS = 30_000;

// One page load serves every requested module: Chrome is launched, the page is
// checked to answer, then the modules' probes run on it — `probes: 'all'`, or
// 'measures' for the ones that measure alone — and each module extracts its
// own sample from what its probes made of the page. With `record` — { dir,
// side, run } — the load keeps a journal of what its probes did
// (src/probes/journal.js), written to that directory however the load ends.
// Chrome is launched with `marker`, by which the main thread finds it should
// Kanso be interrupted before this thread could tell it its pid
// (src/process/chrome.js).
async function audit({ url, formFactor, moduleIds, config, probes = 'all', record, marker }) {
  const modules = moduleIds.map(getModule);
  const journal = record ? new Journal() : undefined;
  journal?.log('load', { schema: SCHEMA, kanso: version(), url, side: record.side, formFactor, run: record.run, startedAt: new Date().toISOString(), probes });

  let chrome;
  try {
    // A signal reaches the main thread only: that is where this Chrome is
    // stopped from if Kanso is, since this `finally` will not run then.
    chrome = await launchChrome({ marker });
    parentPort.postMessage({ chrome: chrome.pid });

    const reached = await reach(chrome.browser, url, formFactor);
    journal?.log('reached', reached);

    const probed = await runProbes({
      browser: chrome.browser, url, formFactor, modules, config,
      measuresOnly: probes === 'measures', journal,
    });

    const samples = Object.fromEntries(modules.map((m) => [m.id, m.extract({ probed: probed[m.id] ?? null })]));
    journal?.log('load-end', { ok: true });
    return { samples };
  } catch (err) {
    journal?.log('load-end', { ok: false, error: err?.message ?? String(err) });
    throw err;
  } finally {
    await chrome?.close();
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
async function reach(browser, url, formFactor) {
  const { context, page } = await newPage(browser, formFactor);
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: REACH_TIMEOUT_MS });
    const status = response?.status() ?? null;
    if (status != null && status >= 400) throw new Error(`the page answered ${status}: ${url}`);
    return { finalUrl: page.url(), status };
  } finally {
    await context.close().catch(() => {});
  }
}

audit(workerData).then(
  ({ samples }) => parentPort.postMessage({ ok: true, samples }),
  (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) }),
);
