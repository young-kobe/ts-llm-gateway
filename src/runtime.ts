import type { Config, SecurityConfig } from './config.js';
import type { GatewayDeps } from './gateway.js';
import { buildDefaultRegistry } from './providers/index.js';
import { RateLimiter, RedisRateLimiter, type Limiter } from './policies/rateLimit.js';
import { ResponseCache } from './policies/cache.js';
import { Metrics, RedisMetrics, type MetricsSink } from './metrics.js';
import { CircuitBreaker } from './policies/circuitBreaker.js';
import { createRedis, createRatelimit } from './store/redis.js';
import type { ApiContext } from './surfaces/pipeline.js';

/** Test seam: inject a mock registry, a tight limiter, custom security, etc. */
export interface ServerOverrides extends Partial<GatewayDeps> {
  rateLimiter?: Limiter;
  security?: SecurityConfig;
  metrics?: MetricsSink;
}

/**
 * Composition root: turn static config into the concrete backends the surfaces
 * run on (an `ApiContext`). A shared Redis backend (if configured) makes the
 * cache, rate limiter, and metrics global + durable across serverless instances;
 * otherwise each falls back to in-process state. Overrides always win, so tests
 * run fully in-memory with no live keys.
 */
export function buildRuntime(config: Config, overrides?: ServerOverrides): ApiContext {
  const redis = createRedis();

  const deps: GatewayDeps = {
    providers: overrides?.providers ?? buildDefaultRegistry(),
    defaultProvider: overrides?.defaultProvider ?? config.defaultProvider,
    retry: overrides?.retry ?? { ...config.retry },
    cache: overrides?.cache ?? new ResponseCache(config.cache, redis),
    fallbackModels: overrides?.fallbackModels ?? config.fallbackModels,
    timeoutMs: overrides?.timeoutMs ?? config.providerTimeoutMs,
    // Per-instance by design (see CircuitBreaker); each instance quarantines and
    // probes providers independently rather than sharing state via Redis.
    breaker: overrides?.breaker ?? new CircuitBreaker(config.circuitBreaker),
  };

  const rateLimiter =
    overrides?.rateLimiter ??
    (redis
      ? new RedisRateLimiter(createRatelimit(redis, config.rateLimit.capacity, config.rateLimit.refillPerSecond))
      : new RateLimiter(config.rateLimit));

  const metrics = overrides?.metrics ?? (redis ? new RedisMetrics(redis) : new Metrics());

  const security = overrides?.security ?? config.security;

  return { deps, rateLimiter, metrics, security };
}
