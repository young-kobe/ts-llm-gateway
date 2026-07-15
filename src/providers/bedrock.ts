import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { Provider } from './index';

/**
 * Primary provider. Credentials come from the standard AWS env vars
 * (`AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optional
 * `AWS_SESSION_TOKEN`). No network call happens until a model is invoked.
 */
export function createBedrockProvider(): Provider {
  const bedrock = createAmazonBedrock();
  return {
    name: 'bedrock',
    languageModel: (modelId) => bedrock(modelId),
  };
}
