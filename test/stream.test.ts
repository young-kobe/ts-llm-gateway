import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { streamChat } from '../src/stream.js';
import { createServer } from '../src/server.js';
import { ResponseCache } from '../src/policies/cache.js';
import type { GatewayDeps } from '../src/gateway.js';
import type { ChatRequest } from '../src/types.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';

const V3_USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
} as const;

/** A ReadableStream that emits `deltas` as a complete, finishing V3 stream. */
function completeStream(deltas: string[]): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'text-start', id: '0' });
      for (const delta of deltas) controller.enqueue({ type: 'text-delta', id: '0', delta });
      controller.enqueue({ type: 'text-end', id: '0' });
      controller.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: V3_USAGE });
      controller.close();
    },
  });
}

function streamingModel(deltas: string[], counter?: { calls: number }): LanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => {
      if (counter) counter.calls++;
      return { stream: completeStream(deltas) };
    },
  });
}

/** A model that emits one delta then blocks until aborted, flipping `flag.aborted`. */
function cancellableModel(flag: { aborted: boolean }): LanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async ({ abortSignal }) => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-start', id: '0' });
          controller.enqueue({ type: 'text-delta', id: '0', delta: 'partial' });
          // Simulate a long-running upstream call; resolve only when cancelled.
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) {
              flag.aborted = true;
              return resolve();
            }
            abortSignal?.addEventListener('abort', () => {
              flag.aborted = true;
              resolve();
            });
          });
          controller.close();
        },
      }),
    }),
  });
}

function registryOf(model: LanguageModelV3): ProviderRegistry {
  const provider = (name: Provider['name']): Provider => ({ name, languageModel: () => model });
  return { bedrock: provider('bedrock'), openai: provider('openai') };
}

function depsOf(model: LanguageModelV3, cache?: ResponseCache): GatewayDeps {
  return {
    providers: registryOf(model),
    defaultProvider: 'bedrock',
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    cache,
  };
}

const REQ: ChatRequest = {
  model: 'anthropic.claude-3-5-sonnet',
  messages: [{ role: 'user', content: 'hi' }],
};

async function collect(gen: AsyncGenerator<import('../src/stream.js').StreamEvent>) {
  const events = [];
  for await (const event of gen) events.push(event);
  return events;
}

describe('streamChat', () => {
  it('yields token deltas then a done event with usage', async () => {
    const events = await collect(streamChat(REQ, depsOf(streamingModel(['Hel', 'lo'])), new AbortController().signal));

    const text = events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('Hello');

    const done = events.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      provider: 'bedrock',
      cached: false,
      usage: { inputTokens: 3, outputTokens: 5 },
    });
  });

  it('replays a cached completion without a second upstream stream', async () => {
    const counter = { calls: 0 };
    const cache = new ResponseCache({ maxEntries: 10 });
    const deps = depsOf(streamingModel(['Hi'], counter), cache);

    await collect(streamChat(REQ, deps, new AbortController().signal)); // populates cache
    const second = await collect(streamChat(REQ, deps, new AbortController().signal));

    expect(counter.calls).toBe(1); // upstream streamed only on the first request
    expect(second.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join('')).toBe('Hi');
    expect(second.at(-1)).toMatchObject({ type: 'done', cached: true });
  });

  it('cancels the upstream provider call when the client aborts (RTSS bridge)', async () => {
    const flag = { aborted: false };
    const controller = new AbortController();
    const gen = streamChat(REQ, depsOf(cancellableModel(flag)), controller.signal);

    const deltas: string[] = [];
    let sawDone = false;
    for await (const event of gen) {
      if (event.type === 'delta') {
        deltas.push(event.text);
        controller.abort(); // client disconnects after the first token
      }
      if (event.type === 'done') sawDone = true;
    }

    expect(deltas).toContain('partial');
    expect(flag.aborted).toBe(true); // abort propagated to the upstream call
    expect(sawDone).toBe(false); // no completion emitted after cancellation
  });
});

describe('POST /v1/chat (stream: true)', () => {
  it('returns an SSE stream of delta events followed by done', async () => {
    const app = createServer({ providers: registryOf(streamingModel(['Hello ', 'world'])), defaultProvider: 'bedrock' });

    const res = await app.request('/v1/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic.claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const body = await res.text();
    expect(body).toContain('event: delta');
    expect(body).toContain('event: done');
    expect(body).toContain('Hello ');
    expect(body).toContain('world');
  });
});
