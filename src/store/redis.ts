import { Redis } from '@upstash/redis';
import { Ratelimit } from '@upstash/ratelimit';

/**
 * Narrow subset of the Upstash Redis client that our stores actually use. Depending
 * on this interface (rather than the concrete client) lets tests supply an in-memory
 * fake and exercise the Redis code paths without a live server.
 */
export interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { px?: number }): Promise<unknown>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  hgetall<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T | null>;
  lpush(key: string, ...values: (string | number)[]): Promise<number>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  /** Batch several writes into ONE round-trip (Upstash `pipeline`). See RedisPipeline. */
  pipeline(): RedisPipeline;
}

/**
 * The subset of Upstash's chainable `Pipeline` our metrics use: queue commands, then
 * `exec()` sends them all in a single HTTP request. Batching the ~9 per-request
 * counter writes into one call cuts request volume (and Upstash quota) roughly 9x.
 */
export interface RedisPipeline {
  hincrby(key: string, field: string, increment: number): RedisPipeline;
  lpush(key: string, ...values: (string | number)[]): RedisPipeline;
  ltrim(key: string, start: number, stop: number): RedisPipeline;
  exec(): Promise<unknown[]>;
}

/** Minimal shape of an Upstash Ratelimit instance, for the same test-fakeability reason. */
export interface DistributedLimiter {
  limit(identifier: string): Promise<{ success: boolean; remaining: number; reset: number }>;
}

/** Default ceiling for a single best-effort store op in the request path. */
export const STORE_OP_TIMEOUT_MS = 2000;

/**
 * Bound a best-effort store operation: resolve to `fallback` if it does not settle
 * within `ms` or if it rejects. This is what makes the shared backends degrade
 * gracefully instead of hanging a request for the whole function duration when
 * Redis is slow or unreachable (fail open for the limiter, cache miss for reads).
 * The underlying op may still settle later; its result/rejection is discarded.
 */
export async function withDeadline<T>(op: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([op.catch(() => fallback), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The real Redis client if REST credentials are configured, else undefined
 * (in-memory fallback). Uses the `KV_*` names injected by the Vercel Marketplace
 * Upstash integration. Note: the REST client needs the HTTPS `KV_REST_API_URL`
 * (not the `redis://` `REDIS_URL`) and the read-write `KV_REST_API_TOKEN` (not
 * `KV_REST_API_READ_ONLY_TOKEN`).
 */
export function createRedis(env: NodeJS.ProcessEnv = process.env): Redis | undefined {
  const url = env.KV_REST_API_URL;
  const token = env.KV_REST_API_TOKEN;
  if (!url || !token) return undefined;
  return new Redis({ url, token });
}

/** A distributed token-bucket limiter over Redis, matching the in-memory limiter's semantics. */
export function createRatelimit(redis: Redis, capacity: number, refillPerSecond: number): Ratelimit {
  return new Ratelimit({
    redis,
    limiter: Ratelimit.tokenBucket(refillPerSecond, '1 s', capacity),
    prefix: 'rl',
    analytics: false,
  });
}
