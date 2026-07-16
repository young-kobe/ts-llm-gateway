export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip a closed circuit open. Must be >= 1. */
  failureThreshold: number;
  /** How long a circuit stays open before allowing a half-open probe (ms). */
  cooldownMs: number;
  /** Injectable clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface Entry {
  state: CircuitState;
  /** Consecutive failures while closed. */
  failures: number;
  /** When the circuit last opened (ms). */
  openedAt: number;
}

/**
 * Per-key circuit breaker for the provider failover chain. After
 * `failureThreshold` consecutive failures a provider's circuit OPENS and requests
 * skip it (fail fast to the next provider) instead of paying retries + backoff +
 * timeout on a provider that is already known to be down. After `cooldownMs` a
 * single HALF-OPEN probe is allowed: success CLOSES the circuit, another failure
 * re-OPENS it for a fresh cooldown. (The standard quarantine-and-probe pattern for
 * an unhealthy dependency, rather than hammering it on every request.)
 *
 * State is in-memory and per-instance BY DESIGN: each serverless instance protects
 * its own requests and probes recovery independently. Unlike the cache or rate
 * limiter, sharing breaker state would let one instance's failures suppress another
 * instance's traffic, which is not what you want.
 */
export class CircuitBreaker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Current state for `key`, transitioning open -> half_open once the cooldown elapses. */
  state(key: string): CircuitState {
    const e = this.entries.get(key);
    if (!e) return 'closed';
    if (e.state === 'open' && this.now() - e.openedAt >= this.options.cooldownMs) {
      e.state = 'half_open';
    }
    return e.state;
  }

  /** Whether a request may attempt `key` right now (blocked only while fully open). */
  allow(key: string): boolean {
    return this.state(key) !== 'open';
  }

  /** Record a successful call: the circuit fully closes. */
  recordSuccess(key: string): void {
    this.entries.set(key, { state: 'closed', failures: 0, openedAt: 0 });
  }

  /** Record a failed call: trip open on threshold (closed) or immediately (half_open probe). */
  recordFailure(key: string): void {
    const e = this.entries.get(key) ?? { state: 'closed' as CircuitState, failures: 0, openedAt: 0 };

    // A half-open probe failed: straight back to open for another cooldown.
    if (e.state === 'half_open') {
      this.entries.set(key, { state: 'open', failures: e.failures, openedAt: this.now() });
      return;
    }

    const failures = e.failures + 1;
    const state: CircuitState = failures >= this.options.failureThreshold ? 'open' : 'closed';
    this.entries.set(key, { state, failures, openedAt: state === 'open' ? this.now() : e.openedAt });
  }
}
