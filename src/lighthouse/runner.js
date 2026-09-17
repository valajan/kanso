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

export const MAX_RUNS = 5;

// Per-metric median of several score objects.
//
// A single Lighthouse run is noisy — TBT in particular swings 20-30% between
// identical runs on shared CPU — which is enough to trip a 10% regression
// threshold on its own and spend an LLM call analysing nothing. Taking the
// median of an odd number of runs is the standard remedy (it is what Lighthouse
// CI does by default); the median is used rather than the mean so one outlier
// run cannot drag the result.
export function medianScores(scores) {
  const usable = scores.filter((s) => s != null);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const out = {};
  for (const key of Object.keys(usable[0])) {
    const values = usable.map((s) => s[key]).filter((v) => typeof v === 'number').sort((a, b) => a - b);
    if (values.length === 0) continue;
    const mid = Math.floor(values.length / 2);
    out[key] = values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }
  return out;
}

// Runs `runs` headless-Chrome Lighthouse audits on `url` and returns the
// per-metric median. Runs are sequential: they compete for the same CPU, so
// overlapping them would be measuring the contention rather than the page.
//
// Rejects only when every run failed — a partial set still yields a usable
// median, and reporting four metrics from two good runs beats reporting none.
export async function runLighthouse(url, { formFactor = 'mobile', runs = 1 } = {}) {
  const count = Math.min(MAX_RUNS, Math.max(1, Math.trunc(runs) || 1));
  const results = [];
  let lastError = null;

  for (let i = 0; i < count; i++) {
    try {
      results.push(await runOnce(url, formFactor));
    } catch (err) {
      lastError = err;
    }
  }

  if (results.length === 0) throw lastError ?? new Error('lighthouse produced no result');
  return medianScores(results);
}

// One audit, in its own worker thread.
async function runOnce(url, formFactor) {
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
