import { Worker } from 'node:worker_threads';
import { SCREENSHOT } from '../core/audit.js';
import { clampRuns } from '../core/runs.js';
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

// Runs `runs` headless-Chrome Lighthouse loads of `url` and returns what each
// module made of them: { [moduleId]: data }, folded by the module's combine().
// Runs are sequential: they compete for the same CPU, so overlapping them
// would be measuring the contention rather than the page.
//
// Rejects only when every run failed — a partial set still yields a usable
// median, and reporting four metrics from two good runs beats reporting none.
//
// The modules' probes run on the first load that succeeds, and no other: what
// they check does not vary from one load to the next, and each costs a page
// load of its own. A probe that measures — INP — is the exception: its number
// is as noisy as TBT's, so it is taken on every load and folded with the rest.
// The screenshot, when asked for, comes from the first load too, under
// SCREENSHOT in the result.
export async function runLighthouse(url, { formFactor = 'mobile', runs = 1, modules = MODULES, config = {}, screenshot = false } = {}) {
  const count = clampRuns(runs);
  const samples = [];
  let shot = null;
  let lastError = null;

  for (let i = 0; i < count; i++) {
    const first = samples.length === 0;
    try {
      const load = await runOnce(url, formFactor, modules.map((m) => m.id), { config, probes: first ? 'all' : 'measures', screenshot: first && screenshot });
      samples.push(load.samples);
      shot ??= load.screenshot;
    } catch (err) {
      lastError = err;
    }
  }

  if (samples.length === 0) throw lastError ?? new Error('lighthouse produced no result');
  const data = Object.fromEntries(modules.map((m) => [m.id, m.combine(samples.map((s) => s[m.id]))]));
  if (shot) data[SCREENSHOT] = shot;
  return data;
}

// One audit, in its own worker thread. The config travels as the plain data a
// YAML file parsed to, which crosses the thread boundary without ceremony.
async function runOnce(url, formFactor, moduleIds, { config, probes, screenshot }) {
  await semaphore.acquire();
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(WORKER_URL, {
        workerData: { url, formFactor, moduleIds, config, probes, screenshot },
      });

      worker.once('message', (msg) => {
        if (msg.ok) resolve({ samples: msg.samples, screenshot: msg.screenshot ?? null });
        else reject(new Error(msg.error));
        // Its answer is all a worker is for. Whatever it may still hold — a
        // Chrome that would not die, a socket to it — must not keep Kanso's
        // process alive after the audit is over.
        worker.terminate();
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
