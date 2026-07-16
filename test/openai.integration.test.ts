import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { createServer } from '../src/server.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';
import type { ProviderName } from '../src/types.js';

/** A mock model that returns fixed text. */
function passingModel(text: string): LanguageModelV3 {
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

function streamingModel(deltas: string[]): LanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          for (const delta of deltas) controller.enqueue({ type: 'text-delta', id: '0', delta });
          controller.enqueue({ type: 'text-end', id: '0' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            },
          });
          controller.close();
        },
      }),
    }),
  });
}

/** Capture which bare model id a provider is asked for, to assert prefix stripping. */
function capturingProvider(name: ProviderName, model: LanguageModelV3, seen: { model?: string }): Provider {
  return {
    name,
    languageModel: (id: string) => {
      seen.model = id;
      return model;
    },
  };
}

function registryOf(bedrock: LanguageModelV3, openai: LanguageModelV3, seen?: { model?: string }): ProviderRegistry {
  const provider = (name: ProviderName, m: LanguageModelV3): Provider =>
    seen ? capturingProvider(name, m, seen) : { name, languageModel: () => m };
  return { bedrock: provider('bedrock', bedrock), openai: provider('openai', openai) };
}

function post(body: unknown) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('POST /v1/chat/completions (OpenAI-compatible)', () => {
  it('returns an OpenAI chat.completion object from the default provider', async () => {
    const app = createServer({
      providers: registryOf(passingModel('hi from bedrock'), passingModel('unused')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat/completions', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('anthropic.claude-3-5-sonnet');
    expect(body.choices[0].message).toEqual({ role: 'assistant', content: 'hi from bedrock' });
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage).toEqual({ prompt_tokens: 7, completion_tokens: 11, total_tokens: 18 });
  });

  it('routes on the provider/model prefix and strips it before the provider call', async () => {
    const seen: { model?: string } = {};
    const app = createServer({
      providers: registryOf(passingModel('from bedrock'), passingModel('from openai'), seen),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat/completions', post({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    // Served by the prefixed provider, model echoed as requested, bare id sent upstream.
    expect(body.choices[0].message.content).toBe('from openai');
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(seen.model).toBe('gpt-4o-mini');
  });

  it('rejects a request for a non-allowlisted resolved model with an OpenAI-shaped error', async () => {
    const app = createServer({
      providers: registryOf(passingModel('x'), passingModel('y')),
      defaultProvider: 'bedrock',
      security: {
        apiKeys: new Set(),
        maxOutputTokens: 1024,
        maxMessages: 50,
        maxContentChars: 8000,
        maxBodyBytes: 100000,
        allowedModels: new Set(['gpt-4o-mini']),
      },
    });

    const res = await app.request('/v1/chat/completions', post({
      model: 'openai/gpt-4-turbo', // resolves to gpt-4-turbo, not allowlisted
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.message).toBe('model_not_allowed');
    expect(body.error.model).toBe('gpt-4-turbo');
  });

  it('streams OpenAI chat.completion.chunk frames terminated by [DONE]', async () => {
    const app = createServer({
      providers: registryOf(streamingModel(['Hello ', 'world']), passingModel('unused')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat/completions', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await res.text();
    expect(body).toContain('chat.completion.chunk');
    expect(body).toContain('"role":"assistant"'); // opening role chunk
    expect(body).toContain('Hello ');
    expect(body).toContain('world');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('data: [DONE]');
  });

  it('still emits the opening role frame when the completion produces no deltas', async () => {
    // A model that returns an empty completion (zero text deltas). A strict OpenAI
    // parser still expects the leading assistant-role chunk before the finish.
    const app = createServer({
      providers: registryOf(streamingModel([]), passingModel('unused')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat/completions', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }));

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('"role":"assistant"'); // role frame present despite no deltas
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('data: [DONE]');
  });
});
