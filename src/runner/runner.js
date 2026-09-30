import { Worker } from 'node:worker_threads';
import { clampRuns } from '../core/runs.js';
import { MODULES } from '../modules/index.js';
import { stopOnExit } from '../process/children.js';
import { chromeByMarker, newMarker } from '../process/chrome.js';

const WORKER_URL = new URL('./runner.worker.js', import.meta.url);

// Global cap on concurrent Chrome workers. Each load spawns one Chrome
// process (~300-400 MB under load); 3 concurrent loads fit comfortably in a
// 1 GB container. Override with KANSO_CONCURRENCY for larger instances.
const MAX_CONCURRENT = Number(process.env.KANSO_CONCURRENCY ?? 3);

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
const LOAD_ATTEMPTS = 2;

// Runs `runs` headless-Chrome loads of `url` and returns what each module
// made of them: { [moduleId]: data }, folded by the module's combine().
// Runs are sequential: they compete for the same CPU, so overlapping them
// would be measuring the contention rather than the page.
//
// A load that fails is tried once more: on a busy machine Chrome now and then
// drops its debugging connection mid-load (ECONNREFUSED), and with one run —
// the default — that alone would cost the whole audit. Rejects only when every
// run failed twice — a partial set still yields a usable median, and
// reporting a measure from two good runs beats reporting none.
//
// The modules' probes run on the first load that succeeds, and no other: what
// they check does not vary from one load to the next, and each costs a page
// load of its own. A probe that measures — INP — is the exception: its number
// is noisy, so it is taken on every load and folded into a median.
//
// With `record` — { dir, side } — every load keeps a journal of what its
// probes did, in that directory (src/probes/journal.js), numbered by run.
export async function runLoads(url, { formFactor = 'mobile', runs = 1, modules = MODULES, config = {}, record = null } = {}) {
  const count = clampRuns(runs);
  const samples = [];
  let lastError = null;

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < LOAD_ATTEMPTS; attempt++) {
      const first = samples.length === 0;
      try {
        const load = await runOnce(url, formFactor, modules.map((m) => m.id), { config, probes: first ? 'all' : 'measures', record: record && { ...record, run: i + 1 } });
        samples.push(load);
        break;
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (samples.length === 0) throw lastError ?? new Error('no load produced a result');
  return Object.fromEntries(modules.map((m) => [m.id, m.combine(samples.map((s) => s[m.id]))]));
}

// One audit, in its own worker thread. The config travels as the plain data a
// YAML file parsed to, which crosses the thread boundary without ceremony.
async function runOnce(url, formFactor, moduleIds, { config, probes, record }) {
  await semaphore.acquire();
  try {
    return await new Promise((resolve, reject) => {
      const marker = newMarker();
      const worker = new Worker(WORKER_URL, {
        workerData: { url, formFactor, moduleIds, config, probes, record, marker },
      });

      // The Chrome the worker launches, stopped from here should Kanso be
      // interrupted (src/process/children.js) — by its pid once the worker
      // tells it, by its marker until then (src/process/chrome.js) —
      // released once the worker is done with it, whichever way.
      let pid;
      const release = stopOnExit(() => pid ?? chromeByMarker(marker));
      worker.once('exit', () => release());

      worker.on('message', (msg) => {
        if (msg.chrome !== undefined) {
          pid = msg.chrome;
          return;
        }
        if (msg.ok) resolve(msg.samples);
        else reject(new Error(msg.error));
        // Its answer is all a worker is for. Whatever it may still hold — a
        // Chrome that would not die, a socket to it — must not keep Kanso's
        // process alive after the audit is over.
        worker.terminate();
      });

      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`audit worker exited with code ${code}`));
      });
    });
  } finally {
    semaphore.release();
  }
}
