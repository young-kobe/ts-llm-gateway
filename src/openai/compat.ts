import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage } from 'ai';
import type { SecurityConfig } from '../config.js';
import type { ChatRequest, ChatResponse, ProviderName } from '../types.js';

/**
 * OpenAI-compatible surface. This module is pure translation: OpenAI wire format
 * in, internal ChatRequest out, and internal ChatResponse in, OpenAI wire format
 * out. It calls no policies itself, so `POST /v1/chat/completions` reuses the same
 * gateway core (cache, retry, failover, timeout, metrics) as the native endpoint.
 */

const PROVIDERS = new Set<ProviderName>(['bedrock', 'openai']);

/**
 * Split an OpenAI `model` field into an optional provider prefix + bare model id:
 *   "openai/gpt-4o-mini" -> { provider: 'openai', model: 'gpt-4o-mini' }
 *   "gpt-4o-mini"        -> { provider: undefined, model: 'gpt-4o-mini' }
 * Only a KNOWN provider prefix is peeled off; anything else is kept whole, so a
 * Bedrock model id or ARN (which can itself contain '/') is never mangled.
 */
export function parseModelRoute(model: string): { provider?: ProviderName; model: string } {
  const slash = model.indexOf('/');
  if (slash === -1) return { model };
  const prefix = model.slice(0, slash);
  if (PROVIDERS.has(prefix as ProviderName)) {
    return { provider: prefix as ProviderName, model: model.slice(slash + 1) };
  }
  return { model };
}

/** The subset of the OpenAI Chat Completions request we accept (plain-text turns). */
export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  /** Legacy field. */
  max_tokens?: number;
  /** Current field; takes precedence over `max_tokens` when both are present. */
  max_completion_tokens?: number;
  stream?: boolean;
}

/** Build the request schema with the same config-driven caps as the native endpoint. */
export function buildOpenAIRequestSchema(security: SecurityConfig) {
  const messageSchema = z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string().min(1).max(security.maxContentChars),
  });

  return z.object({
    model: z.string().min(1),
    messages: z.array(messageSchema).min(1).max(security.maxMessages),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
  });
}

/** Translate a validated OpenAI request into the internal ChatRequest. */
export function toChatRequest(body: OpenAIChatRequest): ChatRequest {
  const route = parseModelRoute(body.model);
  return {
    provider: route.provider,
    model: route.model,
    messages: body.messages as ModelMessage[],
    temperature: body.temperature,
    maxTokens: body.max_completion_tokens ?? body.max_tokens,
  };
}

/** Identity + timestamp shared across a completion (and every chunk of a stream). */
export interface CompletionMeta {
  id: string;
  created: number;
}

/** Mint a fresh completion id + created timestamp (Unix seconds), OpenAI-style. */
export function newCompletionMeta(): CompletionMeta {
  return { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000) };
}

/**
 * Translate the internal result into an OpenAI `chat.completion` object. `model`
 * echoes what the caller requested (including any provider prefix), which is what
 * OpenAI clients expect; the actually-served provider after failover is reflected
 * in the gateway's own /stats, not in this response.
 */
export function toOpenAIResponse(
  result: ChatResponse,
  requestedModel: string,
  meta: CompletionMeta,
): Record<string, unknown> {
  const promptTokens = result.usage.inputTokens ?? 0;
  const completionTokens = result.usage.outputTokens ?? 0;
  return {
    id: meta.id,
    object: 'chat.completion',
    created: meta.created,
    model: requestedModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.text },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function chunk(
  meta: CompletionMeta,
  requestedModel: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, unknown> {
  return {
    id: meta.id,
    object: 'chat.completion.chunk',
    created: meta.created,
    model: requestedModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/** The three chunk shapes of an OpenAI stream: opening role, content deltas, final stop. */
export const openAIChunk = {
  role: (meta: CompletionMeta, model: string) => chunk(meta, model, { role: 'assistant' }, null),
  content: (meta: CompletionMeta, model: string, text: string) => chunk(meta, model, { content: text }, null),
  finish: (meta: CompletionMeta, model: string) => chunk(meta, model, {}, 'stop'),
};
