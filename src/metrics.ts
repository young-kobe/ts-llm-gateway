import type { ProviderName } from './types.js';
import type { RedisLike } from './store/redis.js';

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
 * A metrics sink the server records outcomes into. Recording is fire-and-forget
 * (never blocks the request); `snapshot` reads the current view for the dashboard.
 * Two backends implement it: in-process `Metrics` and shared/durable `RedisMetrics`.
 */
export interface MetricsSink {
  reject(reason: RejectReason): void;
  error(): void;
  success(event: SuccessEvent): void;
  snapshot(): Promise<StatsSnapshot>;
}

/**
 * In-memory metrics for the live dashboard. Counters accumulate over the life of
 * one process/instance (honest on serverless: state is per-instance, not global).
 * The clock is injectable so uptime/latency are testable.
 */
export class Metrics implements MetricsSink {
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

  // eslint-disable-next-line @typescript-eslint/require-await
  async snapshot(): Promise<StatsSnapshot> {
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

const COUNTERS_KEY = 'metrics:counters';
const LATENCY_KEY = 'metrics:latency';

/**
 * Shared, durable metrics backed by Redis: a hash of counters plus a capped list
 * of latency samples. Because all instances read/write the same keys, the
 * dashboard shows a global view that survives cold starts. Writes are
 * fire-and-forget so recording never adds latency to a request.
 */
export class RedisMetrics implements MetricsSink {
  private readonly startedAt: number;

  constructor(private readonly redis: RedisLike, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  private bg(p: Promise<unknown>): void {
    void p.catch(() => {});
  }

  reject(reason: RejectReason): void {
    this.bg(
      this.redis
        .pipeline()
        .hincrby(COUNTERS_KEY, 'requests', 1)
        .hincrby(COUNTERS_KEY, `reject_${reason}`, 1)
        .exec(),
    );
  }

  error(): void {
    this.bg(this.redis.pipeline().hincrby(COUNTERS_KEY, 'requests', 1).hincrby(COUNTERS_KEY, 'errors', 1).exec());
  }

  success(event: SuccessEvent): void {
    // One pipeline -> one round-trip for all of this request's counter writes.
    const p = this.redis.pipeline();
    p.hincrby(COUNTERS_KEY, 'requests', 1);
    p.hincrby(COUNTERS_KEY, 'success', 1);
    p.hincrby(COUNTERS_KEY, `provider_${event.provider}`, 1);
    p.hincrby(COUNTERS_KEY, event.cached ? 'cache_hits' : 'cache_misses', 1);
    if (event.failedOver) p.hincrby(COUNTERS_KEY, 'failovers', 1);
    if (event.inputTokens) p.hincrby(COUNTERS_KEY, 'input_tokens', event.inputTokens);
    if (event.outputTokens) p.hincrby(COUNTERS_KEY, 'output_tokens', event.outputTokens);
    if (event.latencyMs !== undefined) {
      // lpush then ltrim in the same batch, so the sample list stays bounded and the
      // trim can never run without its push (order within a pipeline is preserved).
      p.lpush(LATENCY_KEY, Math.round(event.latencyMs));
      p.ltrim(LATENCY_KEY, 0, LATENCY_SAMPLES - 1);
    }
    this.bg(p.exec());
  }

  async snapshot(): Promise<StatsSnapshot> {
    const [counters, latencyRaw] = await Promise.all([
      this.redis.hgetall<Record<string, unknown>>(COUNTERS_KEY),
      this.redis.lrange(LATENCY_KEY, 0, -1),
    ]);
    const n = (field: string): number => Number(counters?.[field] ?? 0);
    const latencies = (latencyRaw ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const pct = (p: number): number =>
      latencies.length ? (latencies[Math.min(latencies.length - 1, Math.ceil((p / 100) * latencies.length) - 1)] ?? 0) : 0;
    const hits = n('cache_hits');
    const misses = n('cache_misses');
    const cacheable = hits + misses;

    return {
      uptimeMs: this.now() - this.startedAt,
      requests: n('requests'),
      success: n('success'),
      errors: n('errors'),
      rejected: {
        rate_limited: n('reject_rate_limited'),
        unauthorized: n('reject_unauthorized'),
        payload_too_large: n('reject_payload_too_large'),
        invalid_request: n('reject_invalid_request'),
        model_not_allowed: n('reject_model_not_allowed'),
      },
      cache: { hits, misses, hitRate: cacheable ? hits / cacheable : 0 },
      failovers: n('failovers'),
      byProvider: { bedrock: n('provider_bedrock'), openai: n('provider_openai') },
      tokens: { input: n('input_tokens'), output: n('output_tokens') },
      latencyMs: { count: latencies.length, p50: round(pct(50)), p99: round(pct(99)) },
    };
  }
}
