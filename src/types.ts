import type { ModelMessage } from 'ai';

/** Providers the gateway can route to. Bedrock is primary, OpenAI is the failover target. */
export type ProviderName = 'bedrock' | 'openai';

/** A normalized chat request as accepted by `POST /v1/chat` and the gateway core. */
export interface ChatRequest {
  /** Which provider to serve from. Falls back to the configured default when omitted. */
  provider?: ProviderName;
  /** Provider-specific model id (e.g. an inference profile ARN for Bedrock, `gpt-4o-mini` for OpenAI). */
  model: string;
  messages: ModelMessage[];
  temperature?: number;
  /** Upper bound on generated tokens. */
  maxTokens?: number;
}

/** What the gateway returns for a non-streaming completion. */
export interface ChatResponse {
  /** The provider that actually served the response. May differ from the request after failover. */
  provider: ProviderName;
  /** The model that actually served the response. */
  model: string;
  text: string;
  usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
  };
  /** True when served from the response cache without a provider call. */
  cached: boolean;
}
