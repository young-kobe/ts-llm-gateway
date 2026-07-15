import { createHash } from 'node:crypto';
import type { ChatRequest, ChatResponse, ProviderName } from '../types';

/**
 * Response cache keyed on request identity, with LRU eviction and optional TTL.
 *
 * A cache hit returns without ever touching a provider — that's the whole point
 * (and where the Day-3 benchmark's hit-vs-miss latency gap comes from). Identity
 * is the resolved provider + model + messages + generation params, so any change
 * that could change the completion produces a different key.
 *
 * The clock is injectable so TTL expiry is tested deterministically.
 */
export interface CacheOptions {
  /** Maximum entries retained; the least-recently-used entry is evicted past this. */
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

  constructor(private readonly opts: CacheOptions) {
    this.now = opts.now ?? Date.now;
  }

  get(key: string): ChatResponse | undefined {
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

  set(key: string, value: ChatResponse): void {
    if (this.entries.has(key)) this.entries.delete(key);
    const expiresAt = this.opts.ttlMs !== undefined ? this.now() + this.opts.ttlMs : Infinity;
    this.entries.set(key, { value, expiresAt });

    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
