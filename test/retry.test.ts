import { describe, it, expect } from 'vitest';
import { withRetryAndFailover, backoffDelay, type RetryOptions } from '../src/policies/retry.js';

/** Base options with an instrumented sleep so tests assert the backoff schedule with no real waiting. */
function opts(overrides: Partial<RetryOptions> = {}): { options: RetryOptions; sleeps: number[] } {
  const sleeps: number[] = [];
  const options: RetryOptions = {
    maxAttempts: 2,
    baseDelayMs: 100,
    maxDelayMs: 1_000,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...overrides,
  };
  return { options, sleeps };
}

describe('backoffDelay', () => {
  it('doubles each attempt and caps at maxDelayMs', () => {
    expect(backoffDelay(1, 100, 1_000)).toBe(100);
    expect(backoffDelay(2, 100, 1_000)).toBe(200);
    expect(backoffDelay(3, 100, 1_000)).toBe(400);
    expect(backoffDelay(10, 100, 1_000)).toBe(1_000); // capped
  });
});

describe('withRetryAndFailover', () => {
  it('returns immediately on first success without sleeping', async () => {
    const { options, sleeps } = opts();
    let calls = 0;
    const out = await withRetryAndFailover(
      ['A'],
      async () => {
        calls++;
        return 'ok';
      },
      options,
    );
    expect(out).toMatchObject({ result: 'ok', step: 'A', totalAttempts: 1 });
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('retries the same step with exponential backoff before giving up on it', async () => {
    const { options, sleeps } = opts({ maxAttempts: 4 });
    await expect(
      withRetryAndFailover(
        ['A'],
        async () => {
          throw new Error('always down');
        },
        options,
      ),
    ).rejects.toThrow('always down');
    // 4 attempts → 3 backoff waits: 100, 200, 400. No wait after the final attempt.
    expect(sleeps).toEqual([100, 200, 400]);
  });

  it('exhausts the primary, then fails over to the secondary (the RTSS bridge)', async () => {
    const { options, sleeps } = opts({ maxAttempts: 2 });
    const seen: string[] = [];
    const out = await withRetryAndFailover(
      ['primary', 'secondary'],
      async (step) => {
        seen.push(step);
        if (step === 'primary') throw new Error('primary down');
        return `served by ${step}`;
      },
      options,
    );
    expect(out.result).toBe('served by secondary');
    expect(out.step).toBe('secondary');
    // primary tried twice (with one backoff between), secondary once and succeeded.
    expect(seen).toEqual(['primary', 'primary', 'secondary']);
    expect(out.totalAttempts).toBe(3);
    expect(sleeps).toEqual([100]);
  });

  it('does not retry a non-retryable error, fails over straight away', async () => {
    const { options, sleeps } = opts({ maxAttempts: 3, isRetryable: () => false });
    const seen: string[] = [];
    const out = await withRetryAndFailover(
      ['primary', 'secondary'],
      async (step) => {
        seen.push(step);
        if (step === 'primary') throw new Error('bad request');
        return 'served by secondary';
      },
      options,
    );
    expect(out.result).toBe('served by secondary');
    expect(seen).toEqual(['primary', 'secondary']); // one shot each, no retries
    expect(sleeps).toEqual([]);
  });

  it('throws the last error when every step is exhausted', async () => {
    const { options } = opts({ maxAttempts: 1 });
    await expect(
      withRetryAndFailover(
        ['A', 'B'],
        async (step) => {
          throw new Error(`${step} failed`);
        },
        options,
      ),
    ).rejects.toThrow('B failed');
  });
});
