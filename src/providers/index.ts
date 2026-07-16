import type { LanguageModel } from 'ai';
import type { ProviderName } from '../types.js';
import { createBedrockProvider } from './bedrock.js';
import { createOpenAIProvider } from './openai.js';

/**
 * One interface every provider hides behind. The gateway only ever sees this —
 * it never imports a concrete SDK — which is what lets routing, failover, and
 * tests treat providers as interchangeable.
 */
export interface Provider {
  readonly name: ProviderName;
  /** Resolve a provider-specific model id into an AI SDK `LanguageModel`. */
  languageModel(modelId: string): LanguageModel;
}

export type ProviderRegistry = Record<ProviderName, Provider>;

/**
 * Build the real registry from environment credentials. Construction is lazy at
 * call time (the SDK reads creds when a request is made, not here), so this is
 * safe to call without keys present — useful in dev and tests.
 */
export function buildDefaultRegistry(): ProviderRegistry {
  return {
    bedrock: createBedrockProvider(),
    openai: createOpenAIProvider(),
  };
}
