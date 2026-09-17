import { Worker } from 'node:worker_threads';
import { MODULES } from '../modules/index.js';

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

// Runs `runs` headless-Chrome Lighthouse loads of `url` and returns what each
// module made of them: { [moduleId]: data }, folded by the module's combine().
// Runs are sequential: they compete for the same CPU, so overlapping them
// would be measuring the contention rather than the page.
//
// Rejects only when every run failed — a partial set still yields a usable
// median, and reporting four metrics from two good runs beats reporting none.
export async function runLighthouse(url, { formFactor = 'mobile', runs = 1, modules = MODULES } = {}) {
  const count = Math.min(MAX_RUNS, Math.max(1, Math.trunc(runs) || 1));
  const samples = [];
  let lastError = null;

  for (let i = 0; i < count; i++) {
    try {
      samples.push(await runOnce(url, formFactor, modules.map((m) => m.id)));
    } catch (err) {
      lastError = err;
    }
  }

  if (samples.length === 0) throw lastError ?? new Error('lighthouse produced no result');
  return Object.fromEntries(modules.map((m) => [m.id, m.combine(samples.map((s) => s[m.id]))]));
}

// One audit, in its own worker thread.
async function runOnce(url, formFactor, moduleIds) {
  await semaphore.acquire();
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL, {
        workerData: { url, formFactor, moduleIds },
      });

      worker.once('message', (msg) => {
        if (msg.ok) resolve(msg.samples);
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
