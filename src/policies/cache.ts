import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResponse, ProviderName } from '../types.js';
import type { RedisLike } from '../store/redis.js';

/**
 * Response cache keyed on request identity, with optional TTL.
 *
 * A cache hit returns without ever touching a provider; that's the whole point
 * (and where the benchmark's hit-vs-miss latency gap comes from). Identity is the
 * resolved provider + model + messages + generation params, so any change that
 * could change the completion produces a different key.
 *
 * Backend is pluggable: with a `RedisLike` it is a shared, durable cache that
 * holds across serverless instances (Redis handles eviction/TTL); without one it
 * falls back to an in-process LRU. The clock is injectable so in-memory TTL expiry
 * is tested deterministically.
 */
export interface CacheOptions {
  /** Maximum entries retained by the in-memory backend; LRU-evicted past this. */
  maxEntries: number;
  /** Optional time-to-live per entry, in ms. Omit for no expiry. */
  ttlMs?: number;
  now?: () => number;
}

interface Entry {
  value: ChatResponse;
  expiresAt: number;
}

/** Stable cache key for a request as it will be served by `primaryProvider`. */
export function cacheKey(req: ChatRequest, primaryProvider: ProviderName): string {
  // Fixed field order → identical requests hash identically regardless of how
  // the incoming JSON was ordered.
  const identity = {
    provider: primaryProvider,
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? null,
    maxTokens: req.maxTokens ?? null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class ResponseCache {
  // Map preserves insertion order, which we exploit for LRU: the first key is
  // the least-recently-used, and re-inserting on access moves an entry to newest.
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly opts: CacheOptions, private readonly redis?: RedisLike) {
    this.now = opts.now ?? Date.now;
  }

  async get(key: string): Promise<ChatResponse | undefined> {
    if (this.redis) {
      const value = await this.redis.get<ChatResponse>(redisKey(key));
      return value ?? undefined;
    }

    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (this.opts.ttlMs !== undefined && this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }

    // Touch: move to most-recently-used position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  async set(key: string, value: ChatResponse): Promise<void> {
    if (this.redis) {
      // Redis handles expiry (px) and memory-pressure eviction; no manual LRU needed.
      await this.redis.set(redisKey(key), value, this.opts.ttlMs ? { px: this.opts.ttlMs } : undefined);
      return;
    }

    if (this.entries.has(key)) this.entries.delete(key);
    const expiresAt = this.opts.ttlMs !== undefined ? this.now() + this.opts.ttlMs : Infinity;
    this.entries.set(key, { value, expiresAt });

    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** In-memory entry count. Meaningful only for the in-process backend. */
  get size(): number {
    return this.entries.size;
  }
}

function redisKey(key: string): string {
  return `cache:${key}`;
}
