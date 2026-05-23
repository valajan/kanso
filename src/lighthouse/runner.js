import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';

// Runs a single headless-Chrome Lighthouse performance audit on `url` and
// returns the metrics Kanso tracks. Callers must run audits sequentially:
// concurrent Lighthouse instances share Node's performance namespace (via marky)
// and corrupt each other's marks.
export async function runLighthouse(url) {
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox'],
  });

  try {
    const result = await lighthouse(
      url,
      {
        port: chrome.port,
        output: 'json',
        logLevel: 'error',
        onlyCategories: ['performance'],
      }
    );

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
