import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createServer } from '../src/server.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';

function passingModel(text = 'ok'): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 11, text: 11, reasoning: undefined },
      },
      content: [{ type: 'text' as const, text }],
      warnings: [],
    }),
  });
}

function throwingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({ doGenerate: async () => { throw new Error('down'); } });
}

function registryOf(bedrock: LanguageModelV3, openai: LanguageModelV3): ProviderRegistry {
  const provider = (name: Provider['name'], model: LanguageModelV3): Provider => ({ name, languageModel: () => model });
  return { bedrock: provider('bedrock', bedrock), openai: provider('openai', openai) };
}

function post(body: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const CHAT = { model: 'test-model', messages: [{ role: 'user', content: 'hi' }] };

describe('GET /stats', () => {
  it('reflects successes, cache hits, rejects, provider and token totals', async () => {
    const app = createServer({ providers: registryOf(passingModel(), passingModel()), defaultProvider: 'bedrock' });

    await app.request('/v1/chat', post(CHAT));        // miss → provider call
    await app.request('/v1/chat', post(CHAT));        // identical → cache hit
    await app.request('/v1/chat', post({ messages: [] })); // invalid → 400

    const stats = await (await app.request('/stats')).json() as any;

    expect(stats.requests).toBe(3);
    expect(stats.success).toBe(2);
    expect(stats.rejected.invalid_request).toBe(1);
    expect(stats.cache).toMatchObject({ hits: 1, misses: 1, hitRate: 0.5 });
    expect(stats.byProvider.bedrock).toBe(2);
    // Only the non-cached call consumed provider tokens.
    expect(stats.tokens).toEqual({ input: 7, output: 11 });
    expect(stats.latencyMs.count).toBe(1);
  });

  it('counts a failover and attributes it to the serving provider', async () => {
    const app = createServer({
      providers: registryOf(throwingModel(), passingModel('served by openai')),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    });

    await app.request('/v1/chat', post(CHAT));

    const stats = await (await app.request('/stats')).json() as any;
    expect(stats.success).toBe(1);
    expect(stats.failovers).toBe(1);
    expect(stats.byProvider.openai).toBe(1);
    expect(stats.byProvider.bedrock).toBe(0);
  });
});
