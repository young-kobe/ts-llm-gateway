import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import { handleChat } from '../gateway.js';
import { streamChat } from '../stream.js';
import type { ChatRequest } from '../types.js';
import type { SecurityConfig } from '../config.js';
import {
  admit,
  classifyError,
  clampMaxTokens,
  messageSchema,
  modelAllowed,
  primaryOf,
  recordSuccess,
  type ApiContext,
} from './pipeline.js';

/** The native request schema, with config-driven size caps (message count / content length). */
function buildSchema(security: SecurityConfig) {
  return z.object({
    provider: z.enum(['bedrock', 'openai']).optional(),
    model: z.string().min(1),
    messages: z.array(messageSchema(security)).min(1).max(security.maxMessages),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    /** When true, respond with an SSE token stream instead of a single JSON body. */
    stream: z.boolean().optional(),
  });
}

/**
 * The native surface: the gateway's own request/response shape at POST /v1/chat.
 * Its wire format is (near) the canonical ChatRequest itself, so it needs no
 * translation layer, unlike the OpenAI-compatible surface.
 */
export function registerNativeChat(app: Hono, ctx: ApiContext): void {
  const schema = buildSchema(ctx.security);

  app.post('/v1/chat', async (c) => {
    const denied = await admit(ctx, c);
    if (denied) return denied;

    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      ctx.metrics.reject('invalid_request');
      return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
    }

    if (!modelAllowed(ctx, parsed.data.model)) {
      ctx.metrics.reject('model_not_allowed');
      return c.json({ error: 'model_not_allowed', model: parsed.data.model }, 400);
    }

    // `messages` is validated to plain-text turns above; the cast bridges the
    // narrowed literal shape to the SDK's broader ModelMessage union.
    const chatReq: ChatRequest = {
      ...parsed.data,
      maxTokens: clampMaxTokens(ctx, parsed.data.maxTokens),
      messages: parsed.data.messages as ModelMessage[],
    };
    const primary = primaryOf(ctx, parsed.data.provider);

    if (parsed.data.stream) {
      return streamSSE(c, async (sse) => {
        // Bridge client disconnect -> upstream cancellation.
        const controller = new AbortController();
        sse.onAbort(() => controller.abort());

        const start = performance.now();
        for await (const event of streamChat(chatReq, ctx.deps, controller.signal)) {
          await sse.writeSSE({ event: event.type, data: JSON.stringify(event) });
          if (event.type === 'done') {
            recordSuccess(ctx, event, primary, start);
            break;
          }
          if (event.type === 'error') {
            ctx.metrics.error();
            break;
          }
        }
      });
    }

    try {
      const start = performance.now();
      const result = await handleChat(chatReq, ctx.deps);
      recordSuccess(ctx, result, primary, start);
      return c.json(result);
    } catch (err) {
      const e = classifyError(ctx, err);
      return c.json(e.provider ? { error: e.code, provider: e.provider } : { error: e.code, message: e.message }, e.status);
    }
  });
}
