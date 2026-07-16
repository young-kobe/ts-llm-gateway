import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from '../src/policies/timeout.js';

describe('withTimeout', () => {
  it('returns the result when the call finishes in time', async () => {
    const result = await withTimeout(async () => 'ok', 1_000);
    expect(result).toBe('ok');
  });

  it('rejects with TimeoutError when the call stalls', async () => {
    const stall = () => new Promise<string>(() => {}); // never resolves
    await expect(withTimeout(stall, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('aborts the signal it hands the call on timeout', async () => {
    let aborted = false;
    const run = (signal: AbortSignal) =>
      new Promise<string>(() => {
        signal.addEventListener('abort', () => {
          aborted = true;
        });
      });
    await expect(withTimeout(run, 20)).rejects.toBeInstanceOf(TimeoutError);
    expect(aborted).toBe(true);
  });

  it('propagates a fast rejection from the call itself', async () => {
    await expect(withTimeout(async () => { throw new Error('boom'); }, 1_000)).rejects.toThrow('boom');
  });
});
