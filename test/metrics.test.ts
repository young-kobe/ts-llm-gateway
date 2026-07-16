import { describe, it, expect } from 'vitest';
import { Metrics, RedisMetrics } from '../src/metrics.js';
import { FakeRedis } from './helpers/fakeRedis.js';

describe('Metrics (in-memory)', () => {
  it('accumulates counts, cache hit rate, provider/token totals, and latency percentiles', async () => {
    let now = 1_000;
    const m = new Metrics(() => now);

    m.reject('rate_limited');
    m.reject('rate_limited');
    m.error();
    m.success({ provider: 'bedrock', cached: false, failedOver: false, latencyMs: 10, inputTokens: 5, outputTokens: 7 });
    m.success({ provider: 'openai', cached: true, failedOver: true });
    m.success({ provider: 'bedrock', cached: false, failedOver: false, latencyMs: 30 });

    now = 1_500;
    const s = await m.snapshot();

    expect(s.uptimeMs).toBe(500);
    expect(s.requests).toBe(6);
    expect(s.success).toBe(3);
    expect(s.errors).toBe(1);
    expect(s.rejected.rate_limited).toBe(2);

    expect(s.cache).toEqual({ hits: 1, misses: 2, hitRate: 1 / 3 });
    expect(s.failovers).toBe(1);
    expect(s.byProvider).toEqual({ bedrock: 2, openai: 1 });

    // Tokens only from the non-cached call that reported them.
    expect(s.tokens).toEqual({ input: 5, output: 7 });

    // Latency samples [10, 30]: p50 → 10, p99 → 30.
    expect(s.latencyMs).toEqual({ count: 2, p50: 10, p99: 30 });
  });

  it('reports zeros cleanly with no traffic', async () => {
    const s = await new Metrics(() => 0).snapshot();
    expect(s.requests).toBe(0);
    expect(s.cache.hitRate).toBe(0);
    expect(s.latencyMs).toEqual({ count: 0, p50: 0, p99: 0 });
  });
});

describe('RedisMetrics (shared backend)', () => {
  it('records into the shared store and produces the same snapshot shape', async () => {
    const redis = new FakeRedis();
    const m = new RedisMetrics(redis, () => 0);

    m.reject('unauthorized');
    m.success({ provider: 'bedrock', cached: false, failedOver: false, latencyMs: 20, inputTokens: 3, outputTokens: 4 });
    m.success({ provider: 'openai', cached: true, failedOver: true });
    // Let the fire-and-forget writes settle.
    await new Promise((r) => setTimeout(r, 0));

    // A separate instance reading the same store sees the global totals.
    const reader = new RedisMetrics(redis, () => 0);
    const s = await reader.snapshot();

    expect(s.requests).toBe(3);
    expect(s.success).toBe(2);
    expect(s.rejected.unauthorized).toBe(1);
    expect(s.cache).toEqual({ hits: 1, misses: 1, hitRate: 0.5 });
    expect(s.failovers).toBe(1);
    expect(s.byProvider).toEqual({ bedrock: 1, openai: 1 });
    expect(s.tokens).toEqual({ input: 3, output: 4 });
    expect(s.latencyMs).toEqual({ count: 1, p50: 20, p99: 20 });
  });
});
