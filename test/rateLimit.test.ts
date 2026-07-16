import { describe, it, expect } from 'vitest';
import { RateLimiter, RedisRateLimiter } from '../src/policies/rateLimit.js';
import type { DistributedLimiter } from '../src/store/redis.js';

/**
 * Why these matter: the token bucket IS the gateway's admission control. If it
 * let callers exceed capacity, or never recovered after a burst, or leaked one
 * key's budget into another's, it would fail exactly the backpressure job it
 * exists to do. Each test pins one of those invariants with a controlled clock.
 */
describe('RateLimiter (in-memory token bucket)', () => {
  it('allows a burst up to capacity, then denies', async () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 1_000 });

    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);

    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('reports how long to wait for the next token when denied', async () => {
    // capacity 1, 2 tokens/sec: after exhausting, one token is 500ms away.
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 2, now: () => 5_000 });
    await limiter.check('k'); // consume the only token
    const denied = await limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it('refills over elapsed time and allows again', async () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });

    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(false); // drained

    now = 2_000; // 2 seconds → 2 tokens back
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(false);
  });

  it('does not refill beyond capacity', async () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: () => now });
    now = 10_000; // would be 100 tokens uncapped
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(true);
    expect((await limiter.check('k')).allowed).toBe(false); // capped at capacity 2
  });

  it('keeps buckets independent per key', async () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 1_000 });
    expect((await limiter.check('a')).allowed).toBe(true);
    expect((await limiter.check('a')).allowed).toBe(false);
    // b has its own untouched bucket.
    expect((await limiter.check('b')).allowed).toBe(true);
  });
});

describe('RedisRateLimiter (distributed adapter)', () => {
  it('maps a distributed limiter result into the gateway shape', async () => {
    const responses: Array<{ success: boolean; remaining: number; reset: number }> = [
      { success: true, remaining: 4, reset: 6_000 },
      { success: false, remaining: 0, reset: 6_000 },
    ];
    const fake: DistributedLimiter = {
      limit: async () => responses.shift()!,
    };
    const limiter = new RedisRateLimiter(fake, () => 5_500);

    const ok = await limiter.check('k');
    expect(ok).toEqual({ allowed: true, remaining: 4, retryAfterMs: 0 });

    const denied = await limiter.check('k');
    // reset (6000) - now (5500) = 500ms until the bucket refills.
    expect(denied).toEqual({ allowed: false, remaining: 0, retryAfterMs: 500 });
  });

  it('fails OPEN (allows) when the shared limiter hangs, instead of blocking the request', async () => {
    // A limiter that never resolves, standing in for an unreachable/slow Redis.
    const hanging: DistributedLimiter = { limit: () => new Promise(() => {}) };
    const limiter = new RedisRateLimiter(hanging, () => 0, 20); // 20ms deadline

    const result = await limiter.check('k');
    expect(result.allowed).toBe(true); // degraded to allow, did not hang
  });

  it('fails OPEN (allows) when the shared limiter throws', async () => {
    const throwing: DistributedLimiter = {
      limit: async () => {
        throw new Error('redis unreachable');
      },
    };
    const limiter = new RedisRateLimiter(throwing, () => 0, 20);
    expect((await limiter.check('k')).allowed).toBe(true);
  });
});
