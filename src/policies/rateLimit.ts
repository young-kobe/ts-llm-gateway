import { STORE_OP_TIMEOUT_MS, withDeadline, type DistributedLimiter } from '../store/redis.js';

/**
 * Token-bucket rate limiter, one bucket per key (API key / route).
 *
 * The gateway's request-admission control: a steady refill rate with a burst
 * allowance, and a clean "back off for N ms" signal when the caller outruns it.
 *
 * Two backends implement the async `Limiter` interface: an in-process
 * `RateLimiter` (per-instance) and a `RedisRateLimiter` backed by a shared,
 * distributed token bucket (a global limit that holds across instances).
 * The clock is injectable so tests drive time deterministically.
 */
export interface Limiter {
  /** Attempt to consume `cost` tokens for `key`. Non-mutating when denied. */
  check(key: string, cost?: number): Promise<RateLimitResult>;
}

export interface RateLimitOptions {
  /** Maximum tokens a bucket can hold (the burst allowance). */
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

export class RateLimiter implements Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimitOptions) {
    this.now = opts.now ?? Date.now;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async check(key: string, cost = 1): Promise<RateLimitResult> {
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

/**
 * Distributed token-bucket limiter backed by a shared store (Upstash Ratelimit).
 * Because the bucket lives in Redis, the limit is global across serverless
 * instances rather than per-instance.
 */
export class RedisRateLimiter implements Limiter {
  private readonly now: () => number;

  constructor(
    private readonly limiter: DistributedLimiter,
    /** Per-instance limiter used when the shared store is slow or unreachable. */
    private readonly fallback: Limiter,
    now: () => number = Date.now,
    private readonly timeoutMs: number = STORE_OP_TIMEOUT_MS,
  ) {
    this.now = now;
  }

  async check(key: string, cost = 1): Promise<RateLimitResult> {
    // When the shared limiter is slow or unreachable, degrade to per-instance
    // in-memory limiting rather than admitting unconditionally. A Redis outage then
    // loosens the limit (each instance enforces its own bucket, so up to
    // N-instances-worth of traffic) but never removes it, and never hangs the
    // request. A bounded op with a null result signals "no answer from the store".
    const result = await withDeadline(this.limiter.limit(key), this.timeoutMs, null);
    if (!result) return this.fallback.check(key, cost);
    return {
      allowed: result.success,
      remaining: result.remaining,
      retryAfterMs: result.success ? 0 : Math.max(0, result.reset - this.now()),
    };
  }
}
