import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { createServer } from '../src/server.js';
import { RateLimiter } from '../src/policies/rateLimit.js';
import type { SecurityConfig } from '../src/config.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';

function passingModel(text = 'ok', capture?: { opts?: LanguageModelV3CallOptions }): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      if (capture) capture.opts = options;
      return {
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        content: [{ type: 'text' as const, text }],
        warnings: [],
      };
    },
  });
}

function registryOf(model: LanguageModelV3): ProviderRegistry {
  const provider = (name: Provider['name']): Provider => ({ name, languageModel: () => model });
  return { bedrock: provider('bedrock'), openai: provider('openai') };
}

/** Full SecurityConfig with permissive defaults; override per test. */
function sec(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  return {
    apiKeys: new Set(),
    maxOutputTokens: 1024,
    maxMessages: 50,
    maxContentChars: 8_000,
    maxBodyBytes: 100_000,
    allowedModels: new Set(),
    ...overrides,
  };
}

const CHAT = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };

function post(body: unknown, headers: Record<string, string> = {}) {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

describe('auth gate', () => {
  const app = createServer({ providers: registryOf(passingModel()), defaultProvider: 'bedrock', security: sec({ apiKeys: new Set(['secret']) }) });

  it('rejects a request with no key', async () => {
    const res = await app.request('/v1/chat', post(CHAT));
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('rejects a request with a wrong key', async () => {
    const res = await app.request('/v1/chat', post(CHAT, { 'x-api-key': 'guess' }));
    expect(res.status).toBe(401);
  });

  it('accepts a valid key via x-api-key or bearer token', async () => {
    const viaHeader = await app.request('/v1/chat', post(CHAT, { 'x-api-key': 'secret' }));
    const viaBearer = await app.request('/v1/chat', post(CHAT, { authorization: 'Bearer secret' }));
    expect(viaHeader.status).toBe(200);
    expect(viaBearer.status).toBe(200);
  });
});

describe('rate-limit bucketing', () => {
  it('buckets anonymous callers by IP: rotating x-api-key does NOT grant fresh buckets', async () => {
    const app = createServer({
      providers: registryOf(passingModel()),
      defaultProvider: 'bedrock',
      security: sec(), // auth open, so the presented key is untrusted for bucketing
      rateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 1_000 }),
    });
    const ip = { 'x-forwarded-for': '203.0.113.7' };

    const first = await app.request('/v1/chat', post(CHAT, { ...ip, 'x-api-key': 'rot-1' }));
    const second = await app.request('/v1/chat', post(CHAT, { ...ip, 'x-api-key': 'rot-2' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(429); // same IP bucket despite a different key
  });

  it('buckets authorized callers by their key (independent buckets per key)', async () => {
    const app = createServer({
      providers: registryOf(passingModel()),
      defaultProvider: 'bedrock',
      security: sec({ apiKeys: new Set(['k1', 'k2']) }),
      rateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 1_000 }),
    });
    const ip = { 'x-forwarded-for': '203.0.113.7' }; // same IP for all

    const k1a = await app.request('/v1/chat', post(CHAT, { ...ip, 'x-api-key': 'k1' }));
    const k1b = await app.request('/v1/chat', post(CHAT, { ...ip, 'x-api-key': 'k1' }));
    const k2a = await app.request('/v1/chat', post(CHAT, { ...ip, 'x-api-key': 'k2' }));

    expect(k1a.status).toBe(200);
    expect(k1b.status).toBe(429); // k1's bucket is drained
    expect(k2a.status).toBe(200); // k2 has its own bucket
  });
});

describe('request caps', () => {
  it('clamps maxTokens down to the configured ceiling', async () => {
    const capture: { opts?: LanguageModelV3CallOptions } = {};
    const app = createServer({
      providers: registryOf(passingModel('ok', capture)),
      defaultProvider: 'bedrock',
      security: sec({ maxOutputTokens: 100 }),
    });

    await app.request('/v1/chat', post({ ...CHAT, maxTokens: 5_000 }));
    expect(capture.opts?.maxOutputTokens).toBe(100);

    await app.request('/v1/chat', post(CHAT)); // unset → defaults to the ceiling
    expect(capture.opts?.maxOutputTokens).toBe(100);
  });

  it('rejects too many messages and over-long content', async () => {
    const app = createServer({
      providers: registryOf(passingModel()),
      defaultProvider: 'bedrock',
      security: sec({ maxMessages: 2, maxContentChars: 5 }),
    });

    const tooMany = await app.request('/v1/chat', post({
      model: 'test-model',
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    }));
    expect(tooMany.status).toBe(400);

    const tooLong = await app.request('/v1/chat', post({ model: 'test-model', messages: [{ role: 'user', content: 'way too long' }] }));
    expect(tooLong.status).toBe(400);
  });

  it('rejects models outside the allowlist', async () => {
    const app = createServer({
      providers: registryOf(passingModel()),
      defaultProvider: 'bedrock',
      security: sec({ allowedModels: new Set(['gpt-4o-mini']) }),
    });

    const blocked = await app.request('/v1/chat', post({ model: 'evil-expensive-model', messages: [{ role: 'user', content: 'hi' }] }));
    expect(blocked.status).toBe(400);
    expect((await blocked.json() as any).error).toBe('model_not_allowed');

    const allowed = await app.request('/v1/chat', post({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }));
    expect(allowed.status).toBe(200);
  });

  it('rejects an oversized body by Content-Length', async () => {
    const app = createServer({
      providers: registryOf(passingModel()),
      defaultProvider: 'bedrock',
      security: sec({ maxBodyBytes: 20 }),
    });

    const res = await app.request('/v1/chat', post(CHAT, { 'content-length': '999999' }));
    expect(res.status).toBe(413);
  });
});
