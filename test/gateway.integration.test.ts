import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { createServer } from '../src/server';
import type { Provider, ProviderRegistry } from '../src/providers';

/**
 * A provider that ignores the model id and always returns a fixed completion.
 * This lets the whole route — validation, routing, generateText — run end to end
 * with no live credentials. `capturedModelId` records what the gateway asked for
 * so we can assert routing actually resolved the requested model.
 */
function mockProvider(name: Provider['name'], text: string): Provider & { capturedModelId?: string } {
  const holder: Provider & { capturedModelId?: string } = {
    name,
    languageModel: (modelId) => {
      holder.capturedModelId = modelId;
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
    },
  };
  return holder;
}

function mockRegistry(): ProviderRegistry {
  return {
    bedrock: mockProvider('bedrock', 'hello from bedrock'),
    openai: mockProvider('openai', 'hello from openai'),
  };
}

describe('POST /v1/chat', () => {
  it('routes to the default provider (bedrock) and returns its completion', async () => {
    const app = createServer({ providers: mockRegistry(), defaultProvider: 'bedrock' });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic.claude-3-5-sonnet',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-3-5-sonnet',
      text: 'hello from bedrock',
      usage: { inputTokens: 7, outputTokens: 11 },
    });
  });

  it('routes to an explicitly requested provider (openai)', async () => {
    const app = createServer({ providers: mockRegistry(), defaultProvider: 'bedrock' });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe('openai');
    expect(body.text).toBe('hello from openai');
  });

  it('rejects a malformed request with 400 before touching a provider', async () => {
    const app = createServer({ providers: mockRegistry(), defaultProvider: 'bedrock' });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid_request');
  });
});
