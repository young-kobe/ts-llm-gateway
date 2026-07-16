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
}

/** Minimal shape of an Upstash Ratelimit instance, for the same test-fakeability reason. */
export interface DistributedLimiter {
  limit(identifier: string): Promise<{ success: boolean; remaining: number; reset: number }>;
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
