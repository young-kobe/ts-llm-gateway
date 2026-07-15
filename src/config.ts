import type { ProviderName } from './types';

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
  cache: {
    maxEntries: number;
    /** undefined → entries never expire. */
    ttlMs: number | undefined;
  };
  /** Model to use when failing over TO a provider. A provider without one can't be a failover target. */
  fallbackModels: Partial<Record<ProviderName, string>>;
}

function parseProvider(value: string | undefined): ProviderName {
  return value === 'openai' ? 'openai' : 'bedrock';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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
    cache: {
      maxEntries: num(env.CACHE_MAX_ENTRIES, 500),
      ttlMs: env.CACHE_TTL_MS ? num(env.CACHE_TTL_MS, 60_000) : undefined,
    },
    fallbackModels,
  };
}
