import { Hono } from 'hono';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { handleChat, UnknownProviderError, type GatewayDeps } from './gateway.js';
import { streamChat } from './stream.js';
import { buildDefaultRegistry } from './providers/index.js';
import { loadConfig, type SecurityConfig } from './config.js';
import { RateLimiter, RedisRateLimiter, type Limiter } from './policies/rateLimit.js';
import { ResponseCache } from './policies/cache.js';
import { authorize } from './policies/auth.js';
import { Metrics, RedisMetrics, type MetricsSink } from './metrics.js';
import { createRedis, createRatelimit } from './store/redis.js';

/** Build the request schema with config-driven size caps (message count / content length). */
function buildChatRequestSchema(security: SecurityConfig) {
  // Minimal message shape: plain-text turns. Tool/multi-part content is out of scope.
  const messageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(security.maxContentChars),
  });

  return z.object({
    provider: z.enum(['bedrock', 'openai']).optional(),
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1).max(security.maxMessages),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    /** When true, respond with an SSE token stream instead of a single JSON body. */
    stream: z.boolean().optional(),
  });
}

/** Injectable overrides: tests pass a mock registry, tight limiter, or custom security config. */
export interface ServerOverrides extends Partial<GatewayDeps> {
  rateLimiter?: Limiter;
  security?: SecurityConfig;
  metrics?: MetricsSink;
}

/** The API key presented by the caller, if any (explicit header preferred over bearer token). */
function presentedKey(c: Context): string | undefined {
  const explicit = c.req.header('x-api-key');
  if (explicit) return explicit;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return undefined;
}

/** Best-effort client IP from the platform-set forwarding headers (Vercel sets these). */
function clientIp(c: Context): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Build the Hono app. Dependencies default to the real registry + config-driven
 * policies, but every piece is injectable: tests pass a mock registry (no keys)
 * and can swap in a tight rate limiter or a custom security config.
 */
export function createServer(overrides?: ServerOverrides): Hono {
  const config = loadConfig();
  const security = overrides?.security ?? config.security;
  const chatRequestSchema = buildChatRequestSchema(security);

  // A shared Redis backend (if configured) makes the cache, rate limiter, and
  // metrics global + durable across serverless instances; otherwise each falls
  // back to in-process state. Overrides always win (tests inject their own).
  const redis = createRedis();

  const deps: GatewayDeps = {
    providers: overrides?.providers ?? buildDefaultRegistry(),
    defaultProvider: overrides?.defaultProvider ?? config.defaultProvider,
    retry: overrides?.retry ?? { ...config.retry },
    cache: overrides?.cache ?? new ResponseCache(config.cache, redis),
    fallbackModels: overrides?.fallbackModels ?? config.fallbackModels,
  };
  const rateLimiter =
    overrides?.rateLimiter ??
    (redis
      ? new RedisRateLimiter(createRatelimit(redis, config.rateLimit.capacity, config.rateLimit.refillPerSecond))
      : new RateLimiter(config.rateLimit));
  const metrics = overrides?.metrics ?? (redis ? new RedisMetrics(redis) : new Metrics());
  const primaryOf = (provider?: string) => provider ?? deps.defaultProvider;

  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true }));

  // Live counters for the dashboard. Backend is in-memory or Redis (see config).
  app.get('/stats', async (c) => c.json(await metrics.snapshot()));

  app.post('/v1/chat', async (c) => {
    // 1. Reject oversized bodies up front (cheap, before reading/parsing).
    const contentLength = Number(c.req.header('content-length'));
    if (Number.isFinite(contentLength) && contentLength > security.maxBodyBytes) {
      metrics.reject('payload_too_large');
      return c.json({ error: 'payload_too_large', maxBodyBytes: security.maxBodyBytes }, 413);
    }

    // 2. Admission control. Bucket authorized callers by their (validated) key, and
    //    everyone else by client IP, never by the raw, caller-controlled header,
    //    which an attacker could rotate to get a fresh bucket per request.
    const key = presentedKey(c);
    const auth = authorize(key, security.apiKeys);
    const bucket = auth.keyed ? `key:${key}` : `ip:${clientIp(c)}`;
    const limit = await rateLimiter.check(bucket);
    if (!limit.allowed) {
      metrics.reject('rate_limited');
      c.header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
      return c.json({ error: 'rate_limited', retryAfterMs: limit.retryAfterMs }, 429);
    }

    // 3. Authentication (enforced only when an allowlist is configured).
    if (!auth.authorized) {
      metrics.reject('unauthorized');
      c.header('WWW-Authenticate', 'Bearer');
      return c.json({ error: 'unauthorized' }, 401);
    }

    // 4. Validate shape + size caps.
    const parsed = chatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      metrics.reject('invalid_request');
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }

    // 5. Restrict which models may be requested (when an allowlist is configured).
    if (security.allowedModels.size > 0 && !security.allowedModels.has(parsed.data.model)) {
      metrics.reject('model_not_allowed');
      return c.json({ error: 'model_not_allowed', model: parsed.data.model }, 400);
    }

    // 6. Clamp output tokens to the ceiling so no single request can be unboundedly costly.
    const maxTokens = Math.min(parsed.data.maxTokens ?? security.maxOutputTokens, security.maxOutputTokens);

    // `messages` is validated to plain-text turns above; the cast bridges the
    // narrowed literal shape to the SDK's broader ModelMessage union.
    const chatReq = { ...parsed.data, maxTokens, messages: parsed.data.messages as ModelMessage[] };
    const primary = primaryOf(parsed.data.provider);

    if (parsed.data.stream) {
      return streamSSE(c, async (sse) => {
        // Bridge client disconnect → upstream cancellation: when Hono aborts the
        // response stream, abort the controller feeding the provider call.
        const controller = new AbortController();
        sse.onAbort(() => controller.abort());

        const start = performance.now();
        for await (const event of streamChat(chatReq, deps, controller.signal)) {
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === 'done') {
            metrics.success({
              provider: event.provider,
              cached: event.cached,
              failedOver: false, // streaming serves the primary provider only
              // A cache hit makes no provider call, so it consumes no latency or tokens.
              latencyMs: event.cached ? undefined : performance.now() - start,
              inputTokens: event.cached ? undefined : event.usage.inputTokens,
              outputTokens: event.cached ? undefined : event.usage.outputTokens,
            });
            break;
          }
          if (event.type === 'error') {
            metrics.error();
            break;
          }
        }
      });
    }

    try {
      const start = performance.now();
      const result = await handleChat(chatReq, deps);
      metrics.success({
        provider: result.provider,
        cached: result.cached,
        failedOver: result.provider !== primary,
        // A cache hit makes no provider call, so it consumes no latency or tokens.
        latencyMs: result.cached ? undefined : performance.now() - start,
        inputTokens: result.cached ? undefined : result.usage.inputTokens,
        outputTokens: result.cached ? undefined : result.usage.outputTokens,
      });
      return c.json(result);
    } catch (err) {
      metrics.error();
      if (err instanceof UnknownProviderError) {
        return c.json({ error: 'unknown_provider', provider: err.provider }, 400);
      }
      const message = err instanceof Error ? err.message : 'upstream provider error';
      return c.json({ error: 'upstream_error', message }, 502);
    }
  });

  return app;
}
