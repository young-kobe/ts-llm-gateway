import type { Handler } from 'hono';
import { streamSSE } from 'hono/streaming';
import { handleChat } from '../gateway.js';
import { streamChat } from '../stream.js';
import type { ChatRequest } from '../types.js';
import {
  admit,
  classifyError,
  clampMaxTokens,
  modelAllowed,
  primaryOf,
  recordSuccess,
  type ApiContext,
} from './pipeline.js';
import {
  buildOpenAIRequestSchema,
  newCompletionMeta,
  openAIChunk,
  toChatRequest,
  toOpenAIResponse,
  type OpenAIChatRequest,
} from './openai-format.js';

/**
 * OpenAI-compatible surface: accepts the OpenAI Chat Completions request/response
 * shape (so the OpenAI SDK can point straight at the gateway by changing only its
 * baseURL) and routes on a `provider/model` prefix. Returns the route handler;
 * server.ts owns the path (POST /v1/chat/completions). It reuses the same
 * admission + accounting pipeline and gateway core as the native surface; only the
 * wire format differs.
 */
export function openAIChatHandler(ctx: ApiContext): Handler {
  const schema = buildOpenAIRequestSchema(ctx.security);

  return async (c) => {
    const denied = await admit(ctx, c);
    if (denied) return denied;

    const parsed = schema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      ctx.metrics.reject('invalid_request');
      return c.json({ error: { message: 'invalid_request', issues: parsed.error.issues } }, 400);
    }

    const body = parsed.data as OpenAIChatRequest;
    const routed = toChatRequest(body);

    // Allowlist is checked against the resolved (bare) model id, after the prefix.
    if (!modelAllowed(ctx, routed.model)) {
      ctx.metrics.reject('model_not_allowed');
      return c.json({ error: { message: 'model_not_allowed', model: routed.model } }, 400);
    }

    const chatReq: ChatRequest = { ...routed, maxTokens: clampMaxTokens(ctx, routed.maxTokens) };
    const primary = primaryOf(ctx, routed.provider);

    if (body.stream) {
      return streamSSE(c, async (sse) => {
        const controller = new AbortController();
        sse.onAbort(() => controller.abort());

        const meta = newCompletionMeta();
        // OpenAI's first chunk is always the assistant-role delta, even for an
        // empty completion. Emit it up-front so a zero-delta stream still opens
        // correctly rather than sending only the finish chunk + [DONE].
        await sse.writeSSE({ data: JSON.stringify(openAIChunk.role(meta, body.model)) });

        const start = performance.now();
        for await (const event of streamChat(chatReq, ctx.deps, controller.signal)) {
          if (event.type === 'delta') {
            await sse.writeSSE({ data: JSON.stringify(openAIChunk.content(meta, body.model, event.text)) });
          } else if (event.type === 'done') {
            await sse.writeSSE({ data: JSON.stringify(openAIChunk.finish(meta, body.model)) });
            await sse.writeSSE({ data: '[DONE]' });
            recordSuccess(ctx, event, primary, start);
            break;
          } else {
            ctx.metrics.error();
            await sse.writeSSE({ data: JSON.stringify({ error: { message: event.message } }) });
            break;
          }
        }
      });
    }

    try {
      const start = performance.now();
      const result = await handleChat(chatReq, ctx.deps);
      recordSuccess(ctx, result, primary, start);
      return c.json(toOpenAIResponse(result, body.model, newCompletionMeta()));
    } catch (err) {
      const e = classifyError(ctx, err);
      return c.json({ error: { message: e.message } }, e.status);
    }
  };
}
