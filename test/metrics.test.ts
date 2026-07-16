import { describe, it, expect } from 'vitest';
import { Metrics } from '../src/metrics.js';

describe('Metrics', () => {
  it('accumulates counts, cache hit rate, provider/token totals, and latency percentiles', () => {
    let now = 1_000;
    const m = new Metrics(() => now);

    m.reject('rate_limited');
    m.reject('rate_limited');
    m.error();
    m.success({ provider: 'bedrock', cached: false, failedOver: false, latencyMs: 10, inputTokens: 5, outputTokens: 7 });
    m.success({ provider: 'openai', cached: true, failedOver: true });
    m.success({ provider: 'bedrock', cached: false, failedOver: false, latencyMs: 30 });

    now = 1_500;
    const s = m.snapshot();

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

  it('reports zeros cleanly with no traffic', () => {
    const s = new Metrics(() => 0).snapshot();
    expect(s.requests).toBe(0);
    expect(s.cache.hitRate).toBe(0);
    expect(s.latencyMs).toEqual({ count: 0, p50: 0, p99: 0 });
  });
});
