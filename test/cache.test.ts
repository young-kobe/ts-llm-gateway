import { describe, it, expect } from 'vitest';
import { ResponseCache, cacheKey } from '../src/policies/cache';
import type { ChatRequest, ChatResponse } from '../src/types';

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

describe('ResponseCache', () => {
  it('returns undefined on miss and the stored value on hit', () => {
    const cache = new ResponseCache({ maxEntries: 10 });
    expect(cache.get('k')).toBeUndefined();
    cache.set('k', resp('hello'));
    expect(cache.get('k')?.text).toBe('hello');
  });

  it('evicts the least-recently-used entry past capacity', () => {
    const cache = new ResponseCache({ maxEntries: 2 });
    cache.set('a', resp('a'));
    cache.set('b', resp('b'));
    cache.get('a'); // touch 'a' so 'b' becomes least-recently-used
    cache.set('c', resp('c')); // evicts 'b'

    expect(cache.get('a')?.text).toBe('a');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.text).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('expires entries after their TTL', () => {
    let now = 0;
    const cache = new ResponseCache({ maxEntries: 10, ttlMs: 1_000, now: () => now });
    cache.set('k', resp('fresh'));

    now = 999;
    expect(cache.get('k')?.text).toBe('fresh');
    now = 1_000;
    expect(cache.get('k')).toBeUndefined(); // expired exactly at the TTL boundary
  });
});
