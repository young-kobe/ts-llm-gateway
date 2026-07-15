import { generateText } from 'ai';
import type { ChatRequest, ChatResponse, ProviderName } from './types';
import type { ProviderRegistry } from './providers';

/** Everything the gateway core needs, injected so it stays testable without live keys. */
export interface GatewayDeps {
  providers: ProviderRegistry;
  defaultProvider: ProviderName;
}

/** Raised when a request names a provider that isn't in the registry. */
export class UnknownProviderError extends Error {
  constructor(public readonly provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * Core orchestration for a non-streaming completion: pick the provider, resolve
 * the model, call it. This is the seam where the Day-2 policies (rate limit,
 * retry/failover, cache) will wrap the provider call.
 */
export async function handleChat(req: ChatRequest, deps: GatewayDeps): Promise<ChatResponse> {
  const providerName = req.provider ?? deps.defaultProvider;
  const provider = deps.providers[providerName];
  if (!provider) throw new UnknownProviderError(providerName);

  const result = await generateText({
    model: provider.languageModel(req.model),
    messages: req.messages,
    temperature: req.temperature,
    maxOutputTokens: req.maxTokens,
  });

  return {
    provider: providerName,
    model: req.model,
    text: result.text,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
  };
}
