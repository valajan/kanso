// Token-bucket rate limiter keyed by an arbitrary string (Kanso keys on the
// repository slug).
//
// This is the first gate on /v1/audit, ahead of any network call: it costs
// nothing to evaluate, and it caps how much of Kanso's Lighthouse capacity —
// and how much of its outbound API quota — a single repository can claim,
// whether through a misconfigured CI loop or a deliberate flood.
//
// State is process-local. Behind several instances each one enforces its own
// share, which is the intended behaviour: the limit protects the instance.
export class RateLimiter {
  #capacity;
  #refillPerMs;
  #buckets = new Map();
  #maxKeys;

  constructor({ capacity = 10, windowMs = 60_000, maxKeys = 10_000 } = {}) {
    this.#capacity = capacity;
    this.#refillPerMs = capacity / windowMs;
    this.#maxKeys = maxKeys;
  }

  // Consumes one token. Returns { allowed, retryAfterSeconds }.
  take(key, now = Date.now()) {
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      // Bound the key space so an attacker cycling repo slugs cannot grow the
      // map without limit. Buckets are cheap and idempotent to recreate.
      if (this.#buckets.size >= this.#maxKeys) this.#evictStale(now);
      bucket = { tokens: this.#capacity, updatedAt: now };
      this.#buckets.set(key, bucket);
    }

    bucket.tokens = Math.min(this.#capacity, bucket.tokens + (now - bucket.updatedAt) * this.#refillPerMs);
    bucket.updatedAt = now;

    if (bucket.tokens < 1) {
      const waitMs = (1 - bucket.tokens) / this.#refillPerMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    bucket.tokens -= 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #evictStale(now) {
    const fullyRefilledAt = this.#capacity / this.#refillPerMs;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.updatedAt > fullyRefilledAt) this.#buckets.delete(key);
    }
    // Nothing was stale: drop the oldest half rather than refuse new keys.
    if (this.#buckets.size >= this.#maxKeys) {
      const sorted = [...this.#buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [key] of sorted.slice(0, Math.ceil(sorted.length / 2))) this.#buckets.delete(key);
    }
  }
}
