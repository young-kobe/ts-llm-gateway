import type { Context } from 'hono';
import { z } from 'zod';
import { AllProvidersUnavailableError, UnknownProviderError, type GatewayDeps } from '../gateway.js';
import type { Limiter } from '../policies/rateLimit.js';
import type { MetricsSink } from '../metrics.js';
import type { SecurityConfig } from '../config.js';
import type { ChatResponse, ProviderName } from '../types.js';
import { authorize } from '../policies/auth.js';

/**
 * Shared foundation for the inbound API surfaces. A "surface" is the wire format
 * a client speaks (native or OpenAI-compatible); each translates to the canonical
 * ChatRequest and then runs the SAME admission + accounting steps defined here, so
 * the two dialects behave identically apart from their request/response shapes.
 */

/** Everything a surface needs from the runtime to serve a request. */
export interface ApiContext {
  deps: GatewayDeps;
  rateLimiter: Limiter;
  metrics: MetricsSink;
  security: SecurityConfig;
}

/**
 * The shared message shape both surfaces accept: plain-text turns, content length
 * capped by config. Tool/multi-part content is out of scope. Each surface composes
 * this into its own full request schema.
 */
export function messageSchema(security: SecurityConfig) {
  return z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(security.maxContentChars),
  });
}

/** The API key presented by the caller (explicit header preferred over bearer token). */
function presentedKey(c: Context): string | undefined {
  const explicit = c.req.header('x-api-key');
  if (explicit) return explicit;
  const auth = c.req.header('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return undefined;
}

/**
 * Client IP for rate-limit bucketing, from the platform-set forwarding headers.
 * We use `x-real-ip` (which Vercel sets to the real connecting IP and overwrites on
 * any client-supplied value), NOT the leftmost `x-forwarded-for` entry: that entry is
 * caller-controlled, so an attacker could rotate it to mint a fresh bucket per request
 * and bypass the limit entirely. `x-vercel-forwarded-for` is a platform-set fallback.
 * When neither is present (e.g. local dev) callers share one 'unknown' bucket, which
 * fails safe (closed) by lumping unidentifiable callers together.
 */
function clientIp(c: Context): string {
  const realIp = c.req.header('x-real-ip');
  if (realIp) return realIp;
  const vercel = c.req.header('x-vercel-forwarded-for');
  if (vercel) return vercel.split(',')[0]?.trim() ?? 'unknown';
  return 'unknown';
}

/**
 * Format-independent admission control, run before any body parsing:
 *   1. Reject oversized bodies up front (cheap, by Content-Length).
 *   2. Rate-limit, bucketing authorized callers by their (validated) key and
 *      everyone else by client IP, never by the raw, caller-controlled header,
 *      which an attacker could rotate to get a fresh bucket per request.
 *   3. Authenticate (enforced only when an allowlist is configured).
 * Returns a ready-to-send Response to short-circuit, or undefined to proceed.
 */
export async function admit(ctx: ApiContext, c: Context): Promise<Response | undefined> {
  const { security, metrics, rateLimiter } = ctx;

  const contentLength = Number(c.req.header('content-length'));
  if (Number.isFinite(contentLength) && contentLength > security.maxBodyBytes) {
    metrics.reject('payload_too_large');
    return c.json({ error: 'payload_too_large', maxBodyBytes: security.maxBodyBytes }, 413);
  }

  const key = presentedKey(c);
  const auth = authorize(key, security.apiKeys);
  const bucket = auth.keyed ? `key:${key}` : `ip:${clientIp(c)}`;
  const limit = await rateLimiter.check(bucket);
  if (!limit.allowed) {
    metrics.reject('rate_limited');
    c.header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)));
    return c.json({ error: 'rate_limited', retryAfterMs: limit.retryAfterMs }, 429);
  }

  if (!auth.authorized) {
    metrics.reject('unauthorized');
    c.header('WWW-Authenticate', 'Bearer');
    return c.json({ error: 'unauthorized' }, 401);
  }

  return undefined;
}

/** Resolve the primary provider for a request (explicit provider or the default). */
export function primaryOf(ctx: ApiContext, provider?: ProviderName): ProviderName {
  return provider ?? ctx.deps.defaultProvider;
}

/** True when the model is permitted (an empty allowlist permits any model). */
export function modelAllowed(ctx: ApiContext, model: string): boolean {
  return ctx.security.allowedModels.size === 0 || ctx.security.allowedModels.has(model);
}

/** Clamp requested output tokens to the configured ceiling. */
export function clampMaxTokens(ctx: ApiContext, requested: number | undefined): number {
  return Math.min(requested ?? ctx.security.maxOutputTokens, ctx.security.maxOutputTokens);
}

/**
 * Record a served completion. A cache hit made no provider call, so it neither
 * consumed latency/tokens nor counts as a failover.
 */
export function recordSuccess(
  ctx: ApiContext,
  info: { provider: ProviderName; cached: boolean; usage: ChatResponse['usage'] },
  primary: ProviderName,
  start: number,
): void {
  ctx.metrics.success({
    provider: info.provider,
    cached: info.cached,
    failedOver: !info.cached && info.provider !== primary,
    latencyMs: info.cached ? undefined : performance.now() - start,
    inputTokens: info.cached ? undefined : info.usage.inputTokens,
    outputTokens: info.cached ? undefined : info.usage.outputTokens,
  });
}

/**
 * Classify a thrown gateway error into an HTTP status + code + message, recording
 * the error metric as a side effect. Each surface wraps this in its own error
 * envelope (the shape differs; the classification does not).
 */
export function classifyError(
  ctx: ApiContext,
  err: unknown,
): {
  status: 400 | 502 | 503;
  code: 'unknown_provider' | 'upstream_error' | 'circuit_open';
  message: string;
  provider?: string;
} {
  ctx.metrics.error();
  if (err instanceof UnknownProviderError) {
    return { status: 400, code: 'unknown_provider', message: `unknown_provider: ${err.provider}`, provider: err.provider };
  }
  if (err instanceof AllProvidersUnavailableError) {
    return { status: 503, code: 'circuit_open', message: 'all providers temporarily unavailable' };
  }
  return { status: 502, code: 'upstream_error', message: err instanceof Error ? err.message : 'upstream provider error' };
}
