import { describe, it, expect } from 'vitest';
import { ResponseCache, cacheKey } from '../src/policies/cache.js';
import type { ChatRequest, ChatResponse } from '../src/types.js';
import { FakeRedis } from './helpers/fakeRedis.js';

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'anthropic.claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

function resp(text: string): ChatResponse {
  return {
    provider: 'bedrock',
    model: 'anthropic.claude-3-5-sonnet',
    text,
    usage: { inputTokens: 1, outputTokens: 1 },
    cached: false,
  };
}

describe('cacheKey', () => {
  it('is stable for equivalent requests', () => {
    expect(cacheKey(req(), 'bedrock')).toBe(cacheKey(req(), 'bedrock'));
  });

  it('changes when anything that could change the completion changes', () => {
    const base = cacheKey(req(), 'bedrock');
    expect(cacheKey(req({ temperature: 0.5 }), 'bedrock')).not.toBe(base);
    expect(cacheKey(req({ model: 'gpt-4o-mini' }), 'bedrock')).not.toBe(base);
    expect(cacheKey(req({ messages: [{ role: 'user', content: 'bye' }] }), 'bedrock')).not.toBe(base);
    expect(cacheKey(req(), 'openai')).not.toBe(base); // resolved provider is part of identity
  });
});

describe('ResponseCache (in-memory backend)', () => {
  it('returns undefined on miss and the stored value on hit', async () => {
    const cache = new ResponseCache({ maxEntries: 10 });
    expect(await cache.get('k')).toBeUndefined();
    await cache.set('k', resp('hello'));
    expect((await cache.get('k'))?.text).toBe('hello');
  });

  it('evicts the least-recently-used entry past capacity', async () => {
    const cache = new ResponseCache({ maxEntries: 2 });
    await cache.set('a', resp('a'));
    await cache.set('b', resp('b'));
    await cache.get('a'); // touch 'a' so 'b' becomes least-recently-used
    await cache.set('c', resp('c')); // evicts 'b'

    expect((await cache.get('a'))?.text).toBe('a');
    expect(await cache.get('b')).toBeUndefined();
    expect((await cache.get('c'))?.text).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('expires entries after their TTL', async () => {
    let now = 0;
    const cache = new ResponseCache({ maxEntries: 10, ttlMs: 1_000, now: () => now });
    await cache.set('k', resp('fresh'));

    now = 999;
    expect((await cache.get('k'))?.text).toBe('fresh');
    now = 1_000;
    expect(await cache.get('k')).toBeUndefined(); // expired exactly at the TTL boundary
  });
});

describe('ResponseCache (Redis backend)', () => {
  it('reads and writes through the shared store instead of local memory', async () => {
    const redis = new FakeRedis();
    const cache = new ResponseCache({ maxEntries: 10 }, redis);

    expect(await cache.get('k')).toBeUndefined();
    await cache.set('k', resp('from-redis'));
    expect((await cache.get('k'))?.text).toBe('from-redis');

    // A second instance sharing the same store sees the entry (cross-instance durability).
    const other = new ResponseCache({ maxEntries: 10 }, redis);
    expect((await other.get('k'))?.text).toBe('from-redis');
    expect(cache.size).toBe(0); // nothing kept in local memory on the Redis path
  });
});
