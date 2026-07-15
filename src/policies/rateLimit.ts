/**
 * Token-bucket rate limiter, one bucket per key (API key / route).
 *
 * This is the gateway's request-admission control — the direct analogue of the
 * Kinesis shard-polling backpressure that gated ingestion in RTSS: a steady
 * refill rate with a burst allowance, and a clean "back off for N ms" signal
 * when the caller outruns it.
 *
 * The clock is injectable so tests drive time deterministically instead of
 * sleeping.
 */
export interface RateLimitOptions {
  /** Maximum tokens a bucket can hold — the burst allowance. */
  capacity: number;
  /** Tokens replenished per second. Sets the sustained request rate. */
  refillPerSecond: number;
  /** Millisecond clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Tokens left in the bucket after this check (floored). */
  remaining: number;
  /** If denied, how long until enough tokens refill to satisfy the request. 0 when allowed. */
  retryAfterMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Attempt to consume `cost` tokens for `key`. Non-mutating when denied. */
  check(key: string, cost = 1): RateLimitResult {
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.opts.capacity, updatedAt: now };

    // Refill for the elapsed time, capped at capacity.
    const elapsedSec = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.opts.capacity, bucket.tokens + elapsedSec * this.opts.refillPerSecond);
    bucket.updatedAt = now;

    let result: RateLimitResult;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      result = { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    } else {
      const deficit = cost - bucket.tokens;
      const retryAfterMs = Math.ceil((deficit / this.opts.refillPerSecond) * 1000);
      result = { allowed: false, remaining: Math.floor(bucket.tokens), retryAfterMs };
    }

    this.buckets.set(key, bucket);
    return result;
  }
}
