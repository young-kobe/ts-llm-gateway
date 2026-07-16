import { streamText } from 'ai';
import type { ChatRequest, ChatResponse, ProviderName } from './types.js';
import type { GatewayDeps } from './gateway.js';
import { cacheKey } from './policies/cache.js';

/** Events emitted over SSE for a streaming completion. */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; provider: ProviderName; model: string; cached: boolean; usage: ChatResponse['usage'] }
  | { type: 'error'; message: string };

/**
 * Streaming orchestration. Mirrors `handleChat` but yields token deltas as they
 * arrive, and threads `signal` into the upstream call so a client disconnect
 * cancels the provider request, the direct analogue of RTSS shard-consumer
 * cancellation tokens tearing down in-flight work.
 *
 * Scope note: streaming serves the primary provider only. Retry/backoff and
 * cross-provider failover apply to the non-streaming path (`handleChat`); failing
 * over mid-stream after tokens have already been sent isn't safe, so it's out.
 */
export async function* streamChat(
  req: ChatRequest,
  deps: GatewayDeps,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const primary = req.provider ?? deps.defaultProvider;
  const impl = deps.providers[primary];
  if (!impl) {
    yield { type: 'error', message: `Unknown provider: ${primary}` };
    return;
  }

  // Cache hit: replay the stored completion as a single delta, no provider call.
  const key = deps.cache ? cacheKey(req, primary) : undefined;
  if (key && deps.cache) {
    const hit = await deps.cache.get(key);
    if (hit) {
      yield { type: 'delta', text: hit.text };
      yield { type: 'done', provider: hit.provider, model: hit.model, cached: true, usage: hit.usage };
      return;
    }
  }

  const result = streamText({
    model: impl.languageModel(req.model),
    messages: req.messages,
    temperature: req.temperature,
    maxOutputTokens: req.maxTokens,
    abortSignal: signal,
  });

  let full = '';
  try {
    for await (const delta of result.textStream) {
      full += delta;
      yield { type: 'delta', text: delta };
    }

    const usage = await result.usage;
    const response: ChatResponse = {
      provider: primary,
      model: req.model,
      text: full,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      cached: false,
    };
    if (key && deps.cache) await deps.cache.set(key, response);
    yield { type: 'done', provider: primary, model: req.model, cached: false, usage: response.usage };
  } catch (err) {
    // On abort, `result.usage` may still be pending and reject later, so mark it
    // handled so it can't surface as an unhandled rejection.
    void Promise.resolve(result.usage).catch(() => {});
    // A client-driven abort is expected teardown, not an error to report.
    if (signal.aborted) return;
    yield { type: 'error', message: err instanceof Error ? err.message : 'stream error' };
  }
}
