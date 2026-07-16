import { describe, it, expect } from 'vitest';
import { RateLimiter } from '../src/policies/rateLimit.js';

/**
 * Why these matter: the token bucket IS the gateway's admission control. If it
 * let callers exceed capacity, or never recovered after a burst, or leaked one
 * key's budget into another's, it would fail exactly the backpressure job it
 * exists to do. Each test pins one of those invariants with a controlled clock.
 */
describe('RateLimiter (token bucket)', () => {
  it('allows a burst up to capacity, then denies', () => {
    const limiter = new RateLimiter({ capacity: 3, refillPerSecond: 1, now: () => 1_000 });

    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);

    const denied = limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
  });

  it('reports how long to wait for the next token when denied', () => {
    // capacity 1, 2 tokens/sec: after exhausting, one token is 500ms away.
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 2, now: () => 5_000 });
    limiter.check('k'); // consume the only token
    const denied = limiter.check('k');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(500);
  });

  it('refills over elapsed time and allows again', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now });

    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false); // drained

    now = 2_000; // 2 seconds → 2 tokens back
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false);
  });

  it('does not refill beyond capacity', () => {
    let now = 0;
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 10, now: () => now });
    now = 10_000; // would be 100 tokens uncapped
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(true);
    expect(limiter.check('k').allowed).toBe(false); // capped at capacity 2
  });

  it('keeps buckets independent per key', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 1_000 });
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(false);
    // b has its own untouched bucket.
    expect(limiter.check('b').allowed).toBe(true);
  });
});
