import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { createServer } from '../src/server.js';
import { RateLimiter } from '../src/policies/rateLimit.js';
import { CircuitBreaker } from '../src/policies/circuitBreaker.js';
import type { Provider, ProviderRegistry } from '../src/providers/index.js';
import type { ProviderName } from '../src/types.js';

/** A mock model that always returns fixed text and counts how often it's invoked. */
function passingModel(text: string, counter?: { calls: number }): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (counter) counter.calls++;
      return {
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 11, text: 11, reasoning: undefined },
        },
        content: [{ type: 'text' as const, text }],
        warnings: [],
      };
    },
  });
}

/** A mock model that always throws, standing in for a downed provider. */
function throwingModel(counter?: { calls: number }): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (counter) counter.calls++;
      throw new Error('primary provider down');
    },
  });
}

/** A mock model whose call never resolves, standing in for a stalled provider. */
function hangingModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: () => new Promise(() => {}),
  });
}

function provider(name: ProviderName, model: LanguageModelV3): Provider {
  return { name, languageModel: () => model };
}

function registryOf(bedrock: LanguageModelV3, openai: LanguageModelV3): ProviderRegistry {
  return { bedrock: provider('bedrock', bedrock), openai: provider('openai', openai) };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

describe('POST /v1/chat', () => {
  it('routes to the default provider (bedrock) and returns its completion', async () => {
    const app = createServer({
      providers: registryOf(passingModel('hello from bedrock'), passingModel('hello from openai')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toMatchObject({
      provider: 'bedrock',
      model: 'anthropic.claude-3-5-sonnet',
      text: 'hello from bedrock',
      usage: { inputTokens: 7, outputTokens: 11 },
      cached: false,
    });
  });

  it('routes to an explicitly requested provider (openai)', async () => {
    const app = createServer({
      providers: registryOf(passingModel('hello from bedrock'), passingModel('hello from openai')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat', post({
      provider: 'openai',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe('openai');
    expect(body.text).toBe('hello from openai');
  });

  it('rejects a malformed request with 400 before touching a provider', async () => {
    const app = createServer({
      providers: registryOf(passingModel('x'), passingModel('y')),
      defaultProvider: 'bedrock',
    });

    const res = await app.request('/v1/chat', post({ messages: [] }));

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toBe('invalid_request');
  });

  it('serves an identical repeat request from cache without calling the provider again', async () => {
    const counter = { calls: 0 };
    const app = createServer({
      providers: registryOf(passingModel('cached body', counter), passingModel('unused')),
      defaultProvider: 'bedrock',
    });
    const payload = { model: 'anthropic.claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] };

    const first = await app.request('/v1/chat', post(payload));
    const firstBody = await first.json() as any;
    const second = await app.request('/v1/chat', post(payload));
    const secondBody = await second.json() as any;

    expect(firstBody.cached).toBe(false);
    expect(secondBody.cached).toBe(true);
    expect(secondBody.text).toBe('cached body');
    expect(counter.calls).toBe(1); // provider hit exactly once across both requests
  });

  it('fails over from a downed primary to the secondary provider', async () => {
    const app = createServer({
      providers: registryOf(throwingModel(), passingModel('served by openai')),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      // fast, deterministic retry so the test does not actually wait
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
    });

    const res = await app.request('/v1/chat', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.text).toBe('served by openai');
  });

  it('times out a stalled primary and fails over instead of hanging', async () => {
    const app = createServer({
      providers: registryOf(hangingModel(), passingModel('served by openai')),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
      timeoutMs: 30, // primary stalls, so the 30ms deadline forces failover
    });

    const res = await app.request('/v1/chat', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.provider).toBe('openai');
    expect(body.text).toBe('served by openai');
  });

  it('returns 502 when the only provider stalls past the deadline', async () => {
    const app = createServer({
      providers: registryOf(hangingModel(), hangingModel()),
      defaultProvider: 'bedrock',
      retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} },
      timeoutMs: 30,
    });

    const res = await app.request('/v1/chat', post({
      model: 'anthropic.claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(res.status).toBe(502);
  });

  it('returns 429 with a Retry-After header once the rate limit is exhausted', async () => {
    const app = createServer({
      providers: registryOf(passingModel('ok'), passingModel('ok')),
      defaultProvider: 'bedrock',
      rateLimiter: new RateLimiter({ capacity: 1, refillPerSecond: 1, now: () => 1_000 }),
    });
    const payload = post(
      { model: 'anthropic.claude-3-5-sonnet', messages: [{ role: 'user', content: 'hi' }] },
      { 'x-api-key': 'client-1' },
    );

    const first = await app.request('/v1/chat', payload);
    const second = await app.request('/v1/chat', payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get('Retry-After')).toBe('1');
    const body = await second.json() as any;
    expect(body.error).toBe('rate_limited');
  });
});

describe('POST /v1/chat circuit breaker', () => {
  // Distinct message per request so the response cache never masks breaker behavior.
  const uniqueChat = (n: number) =>
    post({ model: 'anthropic.claude-3-5-sonnet', messages: [{ role: 'user', content: `hi ${n}` }] });

  const fastRetry = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, sleep: async () => {} };

  it('opens a failing provider and skips it, failing fast to the secondary', async () => {
    const primaryCalls = { calls: 0 };
    const app = createServer({
      providers: registryOf(throwingModel(primaryCalls), passingModel('served by openai')),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      retry: fastRetry,
      breaker: new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 }),
    });

    const first = await app.request('/v1/chat', uniqueChat(1));
    expect(first.status).toBe(200);
    expect((await first.json() as any).provider).toBe('openai');
    expect(primaryCalls.calls).toBe(1); // primary attempted once, then its circuit opened

    const second = await app.request('/v1/chat', uniqueChat(2));
    expect(second.status).toBe(200);
    expect((await second.json() as any).provider).toBe('openai');
    expect(primaryCalls.calls).toBe(1); // primary skipped entirely: not called again
  });

  it('returns 503 once every provider circuit is open, without calling them', async () => {
    const bedrockCalls = { calls: 0 };
    const openaiCalls = { calls: 0 };
    const app = createServer({
      providers: registryOf(throwingModel(bedrockCalls), throwingModel(openaiCalls)),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      retry: fastRetry,
      breaker: new CircuitBreaker({ failureThreshold: 1, cooldownMs: 60_000 }),
    });

    const first = await app.request('/v1/chat', uniqueChat(1));
    expect(first.status).toBe(502); // both fail on the first request
    const callsAfterFirst = bedrockCalls.calls + openaiCalls.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await app.request('/v1/chat', uniqueChat(2));
    expect(second.status).toBe(503);
    expect((await second.json() as any).error).toBe('circuit_open');
    expect(bedrockCalls.calls + openaiCalls.calls).toBe(callsAfterFirst); // no provider called
  });

  it('probes and closes the circuit after the cooldown when the provider recovers', async () => {
    const clock = { t: 0 };
    const healthy = { ok: false };
    const primary = new MockLanguageModelV3({
      doGenerate: async () => {
        if (!healthy.ok) throw new Error('primary down');
        return {
          finishReason: { unified: 'stop' as const, raw: 'stop' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          content: [{ type: 'text' as const, text: 'primary recovered' }],
          warnings: [],
        };
      },
    });
    const app = createServer({
      providers: registryOf(primary, passingModel('served by openai')),
      defaultProvider: 'bedrock',
      fallbackModels: { openai: 'gpt-4o-mini' },
      retry: fastRetry,
      breaker: new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: () => clock.t }),
    });

    // Trip the primary open, then confirm it's skipped within the cooldown.
    expect((await (await app.request('/v1/chat', uniqueChat(1))).json() as any).provider).toBe('openai');
    expect((await (await app.request('/v1/chat', uniqueChat(2))).json() as any).provider).toBe('openai');

    // Backend recovers; advance past the cooldown so the next request half-open probes it.
    healthy.ok = true;
    clock.t = 1000;
    const recovered = await app.request('/v1/chat', uniqueChat(3));
    expect((await recovered.json() as any).provider).toBe('bedrock'); // probe succeeded, circuit closed
  });
});
