import { randomUUID } from 'node:crypto';

// Bounded background job queue for audit runs.
//
// An audit takes minutes (four Lighthouse runs plus an optional LLM call),
// which is far longer than any caller should hold a connection open for: the
// GitHub webhook delivery times out after 10 seconds, and a CI job should not
// keep a socket parked for the duration either. Both entry points therefore
// hand the work to this queue and answer immediately.
//
// The queue is bounded in both dimensions on purpose. `concurrency` caps how
// many audits run at once, and `maxQueued` caps how many may wait — beyond
// that, enqueueing fails loudly with a 429 instead of letting an unbounded
// backlog absorb every request and time them all out.
//
// Results live in memory with a TTL so a caller can poll for the outcome.
// Losing them on restart is acceptable: the report has already been written to
// the PR, which is the durable record.
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_RETAINED = 500;

export class QueueFullError extends Error {
  constructor(depth) {
    super(`Audit queue is full (${depth} waiting)`);
    this.name = 'QueueFullError';
    this.reason = 'queue_full';
  }
}

export class JobQueue {
  #concurrency;
  #maxQueued;
  #ttlMs;
  #waiting = [];
  #running = 0;
  #jobs = new Map();
  #log;

  constructor({ concurrency = 2, maxQueued = 20, ttlMs = DEFAULT_TTL_MS, log } = {}) {
    this.#concurrency = Math.max(1, concurrency);
    this.#maxQueued = Math.max(1, maxQueued);
    this.#ttlMs = ttlMs;
    this.#log = log;
  }

  // Registers a unit of work and returns a snapshot of its job record
  // immediately. `run` is invoked with no arguments once a slot frees up — which
  // may be during this call, so the snapshot can already read 'running'.
  enqueue({ kind = 'audit', meta = {}, run }) {
    this.#sweep();
    if (this.#waiting.length >= this.#maxQueued) throw new QueueFullError(this.#waiting.length);

    const job = {
      id: randomUUID(),
      kind,
      meta,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
    };
    this.#jobs.set(job.id, job);
    this.#waiting.push({ job, run });
    this.#pump();
    return { ...job };
  }

  get(id) {
    const job = this.#jobs.get(id);
    return job ? { ...job } : null;
  }

  stats() {
    return { running: this.#running, queued: this.#waiting.length, retained: this.#jobs.size };
  }

  // Resolves once nothing is running or waiting. Test helper — production code
  // never blocks on the queue.
  async idle() {
    while (this.#running > 0 || this.#waiting.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  #pump() {
    while (this.#running < this.#concurrency && this.#waiting.length > 0) {
      const { job, run } = this.#waiting.shift();
      this.#running++;
      job.status = 'running';
      job.startedAt = Date.now();

      // A job never rejects outward: a thrown error is recorded on the job and
      // the slot is released, so one bad audit cannot stall the queue or take
      // the process down through an unhandled rejection.
      Promise.resolve()
        .then(run)
        .then(
          (result) => {
            job.status = 'done';
            job.result = result ?? null;
          },
          (err) => {
            job.status = 'error';
            job.error = err?.message ?? String(err);
            this.#log?.error?.(`job ${job.id} (${job.kind}) failed: ${job.error}`);
          }
        )
        .finally(() => {
          job.finishedAt = Date.now();
          this.#running--;
          this.#pump();
        });
    }
  }

  // Drops finished jobs past their TTL, then trims the oldest if the map is
  // still over the retention cap — the queue must not become a memory leak on
  // a long-lived process.
  #sweep() {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt != null && job.finishedAt < cutoff) this.#jobs.delete(id);
    }
    if (this.#jobs.size <= MAX_RETAINED) return;
    const sorted = [...this.#jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (const job of sorted.slice(0, this.#jobs.size - MAX_RETAINED)) {
      if (job.finishedAt != null) this.#jobs.delete(job.id);
    }
  }
}
