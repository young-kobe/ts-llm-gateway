import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { handleChat, UnknownProviderError, type GatewayDeps } from './gateway';
import { streamChat } from './stream';
import { buildDefaultRegistry } from './providers';
import { loadConfig } from './config';
import { RateLimiter } from './policies/rateLimit';
import { ResponseCache } from './policies/cache';

// Minimal message shape for the skeleton: plain-text turns. Tool/multi-part
// content is intentionally out of scope until it's actually needed.
const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const chatRequestSchema = z.object({
  provider: z.enum(['bedrock', 'openai']).optional(),
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  /** When true, respond with an SSE token stream instead of a single JSON body. */
  stream: z.boolean().optional(),
});

/** Injectable overrides — tests pass a mock registry and/or a tight rate limiter. */
export interface ServerOverrides extends Partial<GatewayDeps> {
  rateLimiter?: RateLimiter;
}

/** Rate-limit bucket key: prefer an explicit API key, fall back to a bearer token, else anonymous. */
function apiKeyOf(c: Context): string {
  const explicit = c.req.header('x-api-key');
  if (explicit) return explicit;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return 'anonymous';
}

/**
 * Build the Hono app. Dependencies default to the real registry + config-driven
 * policies, but every piece is injectable — tests pass a mock registry (no keys)
 * and can swap in a tight rate limiter.
 */
export function createServer(overrides?: ServerOverrides): Hono {
  const config = loadConfig();

  const deps: GatewayDeps = {
    providers: overrides?.providers ?? buildDefaultRegistry(),
    defaultProvider: overrides?.defaultProvider ?? config.defaultProvider,
    retry: overrides?.retry ?? { ...config.retry },
    cache: overrides?.cache ?? new ResponseCache(config.cache),
    fallbackModels: overrides?.fallbackModels ?? config.fallbackModels,
  };
  const rateLimiter = overrides?.rateLimiter ?? new RateLimiter(config.rateLimit);

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  app.post('/v1/chat', async (c) => {
    // Admission control first — reject before doing any parsing or upstream work.
    const limit = rateLimiter.check(apiKeyOf(c));
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return c.json({ error: 'rate_limited', retryAfterMs: limit.retryAfterMs }, 429);
    }

    const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }

    // `messages` is validated to plain-text turns above; the cast bridges the
    // narrowed literal shape to the SDK's broader ModelMessage union.
    const chatReq = { ...parsed.data, messages: parsed.data.messages as ModelMessage[] };

    if (parsed.data.stream) {
      return streamSSE(c, async (sse) => {
        // Bridge client disconnect → upstream cancellation: when Hono aborts the
        // response stream, abort the controller feeding the provider call.
        const controller = new AbortController();
        sse.onAbort(() => controller.abort());

        for await (const event of streamChat(chatReq, deps, controller.signal)) {
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === 'done' || event.type === 'error') break;
        }
      });
    }

    try {
      const result = await handleChat(chatReq, deps);
      return c.json(result);
    } catch (err) {
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', provider: err.provider }, 400);
      }
      const message = err instanceof Error ? err.message : 'upstream provider error';
      return c.json({ error: 'upstream_error', message }, 502);
    }
  });

  return app;
}
