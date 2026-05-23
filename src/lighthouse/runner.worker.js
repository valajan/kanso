import { parentPort, workerData } from 'node:worker_threads';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

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

async function audit({ url, formFactor }) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });

  try {
    const formFactorConfig = formFactor === 'desktop' ? DESKTOP_CONFIG : {};
    const result = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      logLevel: 'error',
      onlyCategories: ['performance'],
      ...formFactorConfig,
    });

    const lhr = result.lhr;
    const perfScore = Math.round((lhr.categories.performance.score ?? 0) * 100);
    const lcpMs = lhr.audits['largest-contentful-paint'].numericValue ?? 0;
    const tbtMs = lhr.audits['total-blocking-time'].numericValue ?? 0;
    const cls = lhr.audits['cumulative-layout-shift'].numericValue ?? 0;
    const fcp = lhr.audits['first-contentful-paint'].numericValue ?? 0;

    return {
      performance: perfScore,
      lcp: lcpMs / 1000,
      tbt: tbtMs,
      cls,
      fcp: fcp / 1000,
    };
  } finally {
    await chrome.kill();
  }
}

audit(workerData).then(
  (score) => parentPort.postMessage({ ok: true, score }),
  (err) => parentPort.postMessage({ ok: false, error: err?.message ?? String(err) }),
);
