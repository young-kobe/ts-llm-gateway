import type { ProviderName } from './types';

export interface Config {
  port: number;
  defaultProvider: ProviderName;
}

function parseProvider(value: string | undefined): ProviderName {
  return value === 'openai' ? 'openai' : 'bedrock';
}

/** Read runtime config from the environment, with safe defaults for local dev. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 8787),
    defaultProvider: parseProvider(env.DEFAULT_PROVIDER),
  };
}
