import { generateText } from 'ai';
import type { ChatRequest, ChatResponse, ProviderName } from './types.js';
import type { ProviderRegistry } from './providers/index.js';
import { cacheKey, type ResponseCache } from './policies/cache.js';
import { withRetryAndFailover, type RetryOptions } from './policies/retry.js';

/** Everything the gateway core needs, injected so it stays testable without live keys. */
export interface GatewayDeps {
  providers: ProviderRegistry;
  defaultProvider: ProviderName;
  retry: RetryOptions;
  /** Optional response cache. When present, identical requests skip the provider call. */
  cache?: ResponseCache;
  /**
   * Model to use when failing over TO a given provider. A provider only joins the
   * failover chain if it has a fallback model here — because a request's model id
   * is provider-specific and won't be valid on a different provider.
   */
  fallbackModels?: Partial<Record<ProviderName, string>>;
}

/** Raised when a request names a provider that isn't in the registry. */
export class UnknownProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = 'UnknownProviderError';
  }
}

/** One target in the failover chain: which provider, and which model to ask it for. */
interface Step {
  provider: ProviderName;
  model: string;
}

/** Primary target first, then any other provider that has a configured fallback model. */
function buildChain(primary: ProviderName, model: string, deps: GatewayDeps): Step[] {
  const steps: Step[] = [{ provider: primary, model }];
  for (const name of Object.keys(deps.providers) as ProviderName[]) {
    if (name === primary) continue;
    const fallbackModel = deps.fallbackModels?.[name];
    if (fallbackModel) steps.push({ provider: name, model: fallbackModel });
  }
  return steps;
}

/**
 * Core orchestration for a non-streaming completion, composing the policies:
 * cache lookup → (retry with backoff → cross-provider failover) → cache store.
 * Rate limiting is applied upstream in the HTTP layer.
 */
export async function handleChat(req: ChatRequest, deps: GatewayDeps): Promise<ChatResponse> {
  const primary = req.provider ?? deps.defaultProvider;
  if (!deps.providers[primary]) throw new UnknownProviderError(primary);

  const key = deps.cache ? cacheKey(req, primary) : undefined;
  if (key && deps.cache) {
    const hit = deps.cache.get(key);
    if (hit) return { ...hit, cached: true };
  }

  const { result, step } = await withRetryAndFailover(
    buildChain(primary, req.model, deps),
    async ({ provider, model }): Promise<{ text: string; usage: ChatResponse['usage'] }> => {
      const impl = deps.providers[provider];
      if (!impl) throw new UnknownProviderError(provider);
      const generated = await generateText({
        model: impl.languageModel(model),
        messages: req.messages,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens,
      });
      return {
        text: generated.text,
        usage: {
          inputTokens: generated.usage.inputTokens,
          outputTokens: generated.usage.outputTokens,
        },
      };
    },
    deps.retry,
  );

  const response: ChatResponse = {
    provider: step.provider,
    model: step.model,
    text: result.text,
    usage: result.usage,
    cached: false,
  };

  if (key && deps.cache) deps.cache.set(key, response);
  return response;
}
