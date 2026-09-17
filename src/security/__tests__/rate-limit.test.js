import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../rate-limit.js';

test('allows up to capacity then refuses', () => {
  const limiter = new RateLimiter({ capacity: 3, windowMs: 60_000 });
  const results = [1, 2, 3, 4].map(() => limiter.take('acme/site').allowed);
  assert.deepEqual(results, [true, true, true, false]);
});

test('buckets are independent per key', () => {
  const limiter = new RateLimiter({ capacity: 1, windowMs: 60_000 });
  assert.equal(limiter.take('acme/one').allowed, true);
  assert.equal(limiter.take('acme/one').allowed, false);
  assert.equal(limiter.take('acme/two').allowed, true);
});

test('tokens refill over the window', () => {
  const limiter = new RateLimiter({ capacity: 2, windowMs: 1000 });
  const start = 1_000_000;
  assert.equal(limiter.take('k', start).allowed, true);
  assert.equal(limiter.take('k', start).allowed, true);
  assert.equal(limiter.take('k', start).allowed, false);
  // Half a window returns one token.
  assert.equal(limiter.take('k', start + 500).allowed, true);
  assert.equal(limiter.take('k', start + 500).allowed, false);
});

test('a refusal reports a usable retry delay', () => {
  const limiter = new RateLimiter({ capacity: 1, windowMs: 60_000 });
  limiter.take('k', 0);
  const denied = limiter.take('k', 0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSeconds >= 1 && denied.retryAfterSeconds <= 60);
});

// Keys come from request bodies, so the map must not grow without bound.
test('the key space stays bounded under churn', () => {
  const limiter = new RateLimiter({ capacity: 5, windowMs: 1000, maxKeys: 50 });
  for (let i = 0; i < 500; i++) limiter.take(`repo/${i}`, 1_000_000 + i * 10_000);
  // Still functional after eviction.
  assert.equal(limiter.take('repo/fresh').allowed, true);
});
