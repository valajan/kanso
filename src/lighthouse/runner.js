import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./runner.worker.js', import.meta.url);

// Runs a single headless-Chrome Lighthouse performance audit on `url` in an
// isolated worker thread, returning the metrics Kanso tracks.
//
// Each audit lives in its own worker so concurrent runs don't share Node's
// performance namespace (used by Lighthouse via marky); without isolation,
// parallel audits corrupt each other's marks.
//
// formFactor: 'mobile' (default, matches Lighthouse defaults) or 'desktop'
// (uses Lighthouse's standard desktop preset — wider viewport, no throttling).
export function runLighthouse(url, { formFactor = 'mobile' } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { url, formFactor },
    });

    worker.once('message', (msg) => {
      if (msg.ok) resolve(msg.score);
      else reject(new Error(msg.error));
    });

    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`lighthouse worker exited with code ${code}`));
    });
  });
}
