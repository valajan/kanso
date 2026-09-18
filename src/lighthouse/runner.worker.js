import { parentPort, workerData } from 'node:worker_threads';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import { getModule } from '../modules/index.js';

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
// of their categories, then each module extracts its own sample.
async function audit({ url, formFactor, moduleIds }) {
  const modules = moduleIds.map(getModule);

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
    await chrome.launch();
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

    return Object.fromEntries(modules.map((m) => [m.id, m.extract(result.lhr)]));
  } finally {
    chrome.kill();
  }
}

audit(workerData).then(
  (samples) => parentPort.postMessage({ ok: true, samples }),
  (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) }),
);
