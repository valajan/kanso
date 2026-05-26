import { Worker } from 'node:worker_threads';

const WORKER_URL = new URL('./runner.worker.js', import.meta.url);

// Global cap on concurrent Chrome workers. Each audit spawns one Chrome
// process (~300-400 MB under load); 3 concurrent audits fit comfortably in a
// 1 GB container. Override with LIGHTHOUSE_CONCURRENCY for larger instances.
const MAX_CONCURRENT = Number(process.env.LIGHTHOUSE_CONCURRENCY ?? 3);

class Semaphore {
  #slots;
  #queue = [];

  constructor(max) {
    this.#slots = max;
  }

  acquire() {
    if (this.#slots > 0) {
      this.#slots--;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#queue.push(resolve));
  }

  release() {
    if (this.#queue.length > 0) {
      this.#queue.shift()();
    } else {
      this.#slots++;
    }
  }
}

const semaphore = new Semaphore(MAX_CONCURRENT);

// Runs a single headless-Chrome Lighthouse performance audit on `url` in an
// isolated worker thread, returning the metrics Kanso tracks.
//
// Each audit lives in its own worker so concurrent runs don't share Node's
// performance namespace (used by Lighthouse via marky); without isolation,
// parallel audits corrupt each other's marks.
//
// formFactor: 'mobile' (default, matches Lighthouse defaults) or 'desktop'
// (uses Lighthouse's standard desktop preset — wider viewport, no throttling).
export async function runLighthouse(url, { formFactor = 'mobile' } = {}) {
  await semaphore.acquire();
  try {
    return await new Promise((resolve, reject) => {
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
  } finally {
    semaphore.release();
  }
}
