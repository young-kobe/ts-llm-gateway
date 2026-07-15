import { createOpenAI } from '@ai-sdk/openai';
import type { Provider } from './index';

/**
 * Failover provider. Reads `OPENAI_API_KEY` from the environment. No network
 * call happens until a model is invoked.
 */
export function createOpenAIProvider(): Provider {
  const openai = createOpenAI();
  return {
    name: 'openai',
    languageModel: (modelId) => openai(modelId),
  };
}
