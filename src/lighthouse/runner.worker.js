import { parentPort, workerData } from 'node:worker_threads';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { whenStarted } from '../process/children.js';
import { getModule } from '../modules/index.js';
import { runProbes } from '../probes/index.js';
import { Journal, journalPath, SCHEMA } from '../probes/journal.js';
import { version } from '../version.js';

// Lighthouse desktop preset — matches `lighthouse --preset=desktop` defaults.
const DESKTOP_CONFIG = {
  formFactor: 'desktop',
  screenEmulation: {
    mobile: false,
    width: 1350,
    height: 940,
    deviceScaleFactor: 1,
    disabled: false,
  },
  throttling: {
    rttMs: 40,
    throughputKbps: 10240,
    cpuSlowdownMultiplier: 1,
    requestLatencyMs: 0,
    downloadThroughputKbps: 0,
    uploadThroughputKbps: 0,
  },
};

// One page load serves every requested module: Lighthouse collects the union
// of their categories, then each module extracts its own sample. The modules'
// probes run afterwards on the same Chrome — `probes: 'all'`, or 'measures'
// for the ones that measure alone; with `screenshot`, the page as its load
// ended comes back beside the samples. With `record` — { dir, side, run } —
// the load keeps a journal of what its probes did (src/probes/journal.js),
// written to that directory however the load ends.
async function audit({ url, formFactor, moduleIds, config, probes = 'all', screenshot, record }) {
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
    journal?.log('lighthouse-start', { categories: [...new Set(modules.flatMap((m) => m.categories))] });
    const formFactorConfig = formFactor === 'desktop' ? DESKTOP_CONFIG : {};
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: [...new Set(modules.flatMap((m) => m.categories))],
      ...formFactorConfig,
    });

    // Lighthouse reports a page it could not load as a complete result with
    // every metric at zero, which a module would happily extract and judge —
    // a dead URL then reads as a catastrophically slow page, four of its five
    // rows green. It is a failed load, so it fails the run.
    const { runtimeError } = result.lhr;
    if (runtimeError && runtimeError.code !== 'NO_ERROR') {
      throw new Error(`${runtimeError.code}: ${runtimeError.message}`);
    }
    journal?.log('lighthouse-end', { finalUrl: result.lhr.finalDisplayedUrl, chrome: result.lhr.environment?.hostUserAgent });

    const probed = await runProbes({
      port: chrome.port, url, formFactor, settings: result.lhr.configSettings, modules, config,
      measuresOnly: probes === 'measures', journal,
    });

    // The artifacts stay in this thread: a module keeps what it needs of them
    // in its sample, which is all that crosses back.
    const samples = Object.fromEntries(modules.map((m) => [m.id, m.extract(result.lhr, {
      artifacts: result.artifacts,
      probed: probed[m.id] ?? null,
    })]));
    // The last frame of Lighthouse's trace: a JPEG data URI, the viewport as
    // the load ended.
    const shot = screenshot ? result.lhr.audits['final-screenshot']?.details?.data ?? null : null;
    journal?.log('load-end', { ok: true });
    return { samples, screenshot: shot };
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

audit(workerData).then(
  ({ samples, screenshot }) => parentPort.postMessage({ ok: true, samples, screenshot }),
  (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) }),
);
