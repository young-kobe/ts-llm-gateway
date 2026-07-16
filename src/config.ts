import type { ProviderName } from './types.js';

export interface Config {
  port: number;
  defaultProvider: ProviderName;
  rateLimit: {
    capacity: number;
    refillPerSecond: number;
  };
  retry: {
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  /** Per-provider-call deadline in ms; keep below the serverless function's max duration. */
  providerTimeoutMs: number;
  cache: {
    maxEntries: number;
    /** undefined → entries never expire. */
    ttlMs: number | undefined;
  };
  /** Model to use when failing over TO a provider. A provider without one can't be a failover target. */
  fallbackModels: Partial<Record<ProviderName, string>>;
  security: SecurityConfig;
}

export interface SecurityConfig {
  /** Allowlisted API keys. Empty set → authentication disabled (open endpoint). */
  apiKeys: Set<string>;
  /** Hard ceiling on generated tokens; a larger request `maxTokens` is clamped down to this. */
  maxOutputTokens: number;
  /** Reject requests with more than this many messages. */
  maxMessages: number;
  /** Reject a message whose content exceeds this many characters. */
  maxContentChars: number;
  /** Reject a request body larger than this (by Content-Length). */
  maxBodyBytes: number;
  /** Allowlisted model ids. Empty set → any model permitted. */
  allowedModels: Set<string>;
}

function parseProvider(value: string | undefined): ProviderName {
  return value === 'openai' ? 'openai' : 'bedrock';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse a comma-separated env var into a set of trimmed, non-empty values. */
function set(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Read runtime config from the environment, with safe defaults for local dev. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const fallbackModels: Partial<Record<ProviderName, string>> = {};
  if (env.BEDROCK_FALLBACK_MODEL) fallbackModels.bedrock = env.BEDROCK_FALLBACK_MODEL;
  if (env.OPENAI_FALLBACK_MODEL) fallbackModels.openai = env.OPENAI_FALLBACK_MODEL;

  return {
    port: num(env.PORT, 8787),
    defaultProvider: parseProvider(env.DEFAULT_PROVIDER),
    rateLimit: {
      capacity: num(env.RATE_LIMIT_CAPACITY, 20),
      refillPerSecond: num(env.RATE_LIMIT_REFILL_PER_SEC, 5),
    },
    retry: {
      maxAttempts: num(env.RETRY_MAX_ATTEMPTS, 2),
      baseDelayMs: num(env.RETRY_BASE_DELAY_MS, 200),
      maxDelayMs: num(env.RETRY_MAX_DELAY_MS, 2000),
    },
    providerTimeoutMs: num(env.PROVIDER_TIMEOUT_MS, 20_000),
    cache: {
      maxEntries: num(env.CACHE_MAX_ENTRIES, 500),
      ttlMs: env.CACHE_TTL_MS ? num(env.CACHE_TTL_MS, 60_000) : undefined,
    },
    fallbackModels,
    security: {
      apiKeys: set(env.GATEWAY_API_KEYS),
      maxOutputTokens: num(env.MAX_OUTPUT_TOKENS, 1024),
      maxMessages: num(env.MAX_MESSAGES, 50),
      maxContentChars: num(env.MAX_CONTENT_CHARS, 8_000),
      maxBodyBytes: num(env.MAX_BODY_BYTES, 100_000),
      allowedModels: set(env.ALLOWED_MODELS),
    },
  };
}
