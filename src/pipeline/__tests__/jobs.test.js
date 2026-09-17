import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JobQueue, QueueFullError } from '../jobs.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('enqueue returns immediately with a queued job', () => {
  const queue = new JobQueue({ concurrency: 1 });
  const job = queue.enqueue({ run: async () => 'done' });
  assert.match(job.id, /^[0-9a-f-]{36}$/);
  assert.ok(['queued', 'running'].includes(queue.get(job.id).status));
});

test('a completed job exposes its result', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const job = queue.enqueue({ run: async () => ({ conclusion: 'pass' }) });
  await queue.idle();
  const done = queue.get(job.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result, { conclusion: 'pass' });
  assert.equal(done.error, null);
});

// A thrown audit must not surface as an unhandled rejection or wedge the slot.
test('a failing job is recorded and frees its slot', async () => {
  const queue = new JobQueue({ concurrency: 1 });
  const failing = queue.enqueue({ run: async () => { throw new Error('lighthouse died'); } });
  const following = queue.enqueue({ run: async () => 'ok' });
  await queue.idle();
  assert.equal(queue.get(failing.id).status, 'error');
  assert.equal(queue.get(failing.id).error, 'lighthouse died');
  assert.equal(queue.get(following.id).result, 'ok');
});

test('concurrency caps how many jobs run at once', async () => {
  const queue = new JobQueue({ concurrency: 2 });
  let active = 0;
  let peak = 0;
  const run = async () => {
    active++;
    peak = Math.max(peak, active);
    await tick(10);
    active--;
  };
  for (let i = 0; i < 6; i++) queue.enqueue({ run });
  await queue.idle();
  assert.equal(peak, 2);
});

test('the queue refuses work past maxQueued rather than growing', async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueued: 2 });
  const block = async () => tick(30);
  queue.enqueue({ run: block }); // takes the only slot
  queue.enqueue({ run: block }); // waiting 1
  queue.enqueue({ run: block }); // waiting 2
  assert.throws(() => queue.enqueue({ run: block }), QueueFullError);
  await queue.idle();
  // Capacity is restored once the backlog drains.
  assert.doesNotThrow(() => queue.enqueue({ run: async () => 'ok' }));
  await queue.idle();
});

test('stats report running and queued depth', async () => {
  const queue = new JobQueue({ concurrency: 1, maxQueued: 5 });
  queue.enqueue({ run: async () => tick(20) });
  queue.enqueue({ run: async () => tick(20) });
  const stats = queue.stats();
  assert.equal(stats.running, 1);
  assert.equal(stats.queued, 1);
  await queue.idle();
});

test('finished jobs are swept once past their TTL', async () => {
  const queue = new JobQueue({ concurrency: 1, ttlMs: 0 });
  const job = queue.enqueue({ run: async () => 'x' });
  await queue.idle();
  assert.equal(queue.get(job.id).status, 'done');
  // The next enqueue sweeps anything already past its TTL.
  queue.enqueue({ run: async () => 'y' });
  await queue.idle();
  assert.equal(queue.get(job.id), null);
});

test('get returns null for an unknown id', () => {
  assert.equal(new JobQueue().get('nope'), null);
});
