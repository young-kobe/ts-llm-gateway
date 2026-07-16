import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '../src/policies/circuitBreaker.js';

/** A breaker with a mutable clock, so tests advance time without real waits. */
function breakerAt(clock: { t: number }, opts: { failureThreshold: number; cooldownMs: number }) {
  return new CircuitBreaker({ ...opts, now: () => clock.t });
}

describe('CircuitBreaker', () => {
  it('starts closed and allows unknown keys', () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    expect(b.state('bedrock')).toBe('closed');
    expect(b.allow('bedrock')).toBe(true);
  });

  it('opens only after `failureThreshold` CONSECUTIVE failures', () => {
    const clock = { t: 0 };
    const b = breakerAt(clock, { failureThreshold: 3, cooldownMs: 1000 });

    b.recordFailure('bedrock');
    b.recordFailure('bedrock');
    expect(b.allow('bedrock')).toBe(true); // 2 < 3, still closed

    b.recordFailure('bedrock');
    expect(b.state('bedrock')).toBe('open');
    expect(b.allow('bedrock')).toBe(false); // open -> blocked
  });

  it('resets the failure count on any success (failures must be consecutive)', () => {
    const b = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
    b.recordFailure('bedrock');
    b.recordFailure('bedrock');
    b.recordSuccess('bedrock'); // resets
    b.recordFailure('bedrock');
    b.recordFailure('bedrock');
    expect(b.allow('bedrock')).toBe(true); // only 2 in a row since the reset
  });

  it('stays open until the cooldown elapses, then allows one half-open probe', () => {
    const clock = { t: 0 };
    const b = breakerAt(clock, { failureThreshold: 1, cooldownMs: 1000 });

    b.recordFailure('bedrock'); // opens at t=0
    expect(b.allow('bedrock')).toBe(false);

    clock.t = 999;
    expect(b.allow('bedrock')).toBe(false); // still within cooldown

    clock.t = 1000;
    expect(b.state('bedrock')).toBe('half_open'); // cooldown elapsed -> probe allowed
    expect(b.allow('bedrock')).toBe(true);
  });

  it('closes on a successful half-open probe', () => {
    const clock = { t: 0 };
    const b = breakerAt(clock, { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure('bedrock');
    clock.t = 1000;
    expect(b.state('bedrock')).toBe('half_open');

    b.recordSuccess('bedrock'); // probe succeeded
    expect(b.state('bedrock')).toBe('closed');
    expect(b.allow('bedrock')).toBe(true);
  });

  it('re-opens for a fresh cooldown when a half-open probe fails', () => {
    const clock = { t: 0 };
    const b = breakerAt(clock, { failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure('bedrock'); // opens at t=0
    clock.t = 1000;
    expect(b.state('bedrock')).toBe('half_open');

    b.recordFailure('bedrock'); // probe failed -> re-open at t=1000
    expect(b.allow('bedrock')).toBe(false);
    clock.t = 1999;
    expect(b.allow('bedrock')).toBe(false); // new cooldown counts from t=1000
    clock.t = 2000;
    expect(b.allow('bedrock')).toBe(true);
  });

  it('tracks keys independently', () => {
    const b = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000 });
    b.recordFailure('bedrock');
    expect(b.allow('bedrock')).toBe(false);
    expect(b.allow('openai')).toBe(true); // openai untouched
  });
});
