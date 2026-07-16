import type { ProviderName } from './types.js';

/** Reasons a request was rejected before reaching a provider. */
export type RejectReason =
  | 'rate_limited'
  | 'unauthorized'
  | 'payload_too_large'
  | 'invalid_request'
  | 'model_not_allowed';

export interface SuccessEvent {
  provider: ProviderName;
  cached: boolean;
  /** True when the serving provider differs from the one originally routed to (failover happened). */
  failedOver: boolean;
  /** Provider-call latency in ms. Omitted for cache hits (no provider call was made). */
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface StatsSnapshot {
  uptimeMs: number;
  requests: number;
  success: number;
  errors: number;
  rejected: Record<RejectReason, number>;
  cache: { hits: number; misses: number; hitRate: number };
  failovers: number;
  byProvider: Record<ProviderName, number>;
  tokens: { input: number; output: number };
  /** Provider-call latency (cache hits excluded). */
  latencyMs: { count: number; p50: number; p99: number };
}

/** Cap on retained latency samples; percentiles are computed over the most recent ones. */
const LATENCY_SAMPLES = 1000;

/**
 * In-memory metrics for the live dashboard. Counters accumulate over the life of
 * one process/instance (honest on serverless: state is per-instance, not global).
 * The clock is injectable so uptime/latency are testable.
 */
export class Metrics {
  private readonly now: () => number;
  private readonly startedAt: number;

  private requests = 0;
  private successes = 0;
  private errors = 0;
  private failovers = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly rejected: Record<RejectReason, number> = {
    rate_limited: 0,
    unauthorized: 0,
    payload_too_large: 0,
    invalid_request: 0,
    model_not_allowed: 0,
  };
  private readonly byProvider: Record<ProviderName, number> = { bedrock: 0, openai: 0 };
  private readonly latencies: number[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  reject(reason: RejectReason): void {
    this.requests++;
    this.rejected[reason]++;
  }

  error(): void {
    this.requests++;
    this.errors++;
  }

  success(event: SuccessEvent): void {
    this.requests++;
    this.successes++;
    this.byProvider[event.provider]++;
    if (event.cached) this.cacheHits++;
    else this.cacheMisses++;
    if (event.failedOver) this.failovers++;
    if (event.inputTokens) this.inputTokens += event.inputTokens;
    if (event.outputTokens) this.outputTokens += event.outputTokens;
    if (event.latencyMs !== undefined) {
      this.latencies.push(event.latencyMs);
      if (this.latencies.length > LATENCY_SAMPLES) this.latencies.shift();
    }
  }

  snapshot(): StatsSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const pct = (p: number): number =>
      sorted.length ? (sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0) : 0;
    const cacheable = this.cacheHits + this.cacheMisses;

    return {
      uptimeMs: this.now() - this.startedAt,
      requests: this.requests,
      success: this.successes,
      errors: this.errors,
      rejected: { ...this.rejected },
      cache: {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: cacheable ? this.cacheHits / cacheable : 0,
      },
      failovers: this.failovers,
      byProvider: { ...this.byProvider },
      tokens: { input: this.inputTokens, output: this.outputTokens },
      latencyMs: { count: sorted.length, p50: round(pct(50)), p99: round(pct(99)) },
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
