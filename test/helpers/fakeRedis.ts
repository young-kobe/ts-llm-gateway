import type { RedisLike, RedisPipeline } from '../../src/store/redis.js';

/**
 * In-memory stand-in for the Upstash Redis client, implementing only the methods
 * our stores use. Lets tests exercise the Redis code paths deterministically with
 * no live server. (Upstash auto-serializes JSON on set / deserializes on get; this
 * fake keeps values as-is, which is behaviorally equivalent for our usage.)
 */
export class FakeRedis implements RedisLike {
  private readonly kv = new Map<string, unknown>();
  private readonly hashes = new Map<string, Map<string, number>>();
  private readonly lists = new Map<string, string[]>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.kv.has(key) ? this.kv.get(key) : null) as T | null;
  }

  async set(key: string, value: unknown): Promise<unknown> {
    this.kv.set(key, value);
    return 'OK';
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const hash = this.hashes.get(key) ?? new Map<string, number>();
    const next = (hash.get(field) ?? 0) + increment;
    hash.set(field, next);
    this.hashes.set(key, hash);
    return next;
  }

  async hgetall<T extends Record<string, unknown> = Record<string, unknown>>(key: string): Promise<T | null> {
    const hash = this.hashes.get(key);
    return hash ? (Object.fromEntries(hash) as T) : null;
  }

  async lpush(key: string, ...values: (string | number)[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values.map(String));
    this.lists.set(key, list);
    return list.length;
  }

  async ltrim(key: string, start: number, stop: number): Promise<unknown> {
    const list = this.lists.get(key) ?? [];
    this.lists.set(key, list.slice(start, stop === -1 ? undefined : stop + 1));
    return 'OK';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return list.slice(start, stop === -1 ? undefined : stop + 1);
  }

  pipeline(): RedisPipeline {
    return new FakePipeline(this);
  }
}

/**
 * Collects queued commands and applies them in order on `exec`, mirroring how a real
 * Upstash pipeline batches writes (order-preserving, executed as one unit for us).
 */
class FakePipeline implements RedisPipeline {
  private readonly ops: Array<() => Promise<unknown>> = [];

  constructor(private readonly redis: FakeRedis) {}

  hincrby(key: string, field: string, increment: number): RedisPipeline {
    this.ops.push(() => this.redis.hincrby(key, field, increment));
    return this;
  }

  lpush(key: string, ...values: (string | number)[]): RedisPipeline {
    this.ops.push(() => this.redis.lpush(key, ...values));
    return this;
  }

  ltrim(key: string, start: number, stop: number): RedisPipeline {
    this.ops.push(() => this.redis.ltrim(key, start, stop));
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const op of this.ops) results.push(await op());
    return results;
  }
}
