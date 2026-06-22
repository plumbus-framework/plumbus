import type { PlumbusConfig } from '@plumbus/core';
import type { VoiceProviderCredentials } from '../types/provider.js';

/**
 * Bridge Plumbus bootstrap AI config into voice OpenAI STT/TTS adapter credentials.
 */
export function resolveVoiceOpenAICredentials(
  config: Pick<PlumbusConfig, 'aiProviders' | 'ai'>,
): VoiceProviderCredentials | undefined {
  const fromProviders = config.aiProviders?.providers?.openai;
  if (fromProviders?.apiKey) {
    return {
      apiKey: fromProviders.apiKey,
      baseUrl: fromProviders.baseUrl,
      options: fromProviders.model ? { model: fromProviders.model } : undefined,
    };
  }

  const legacy = config.ai;
  if (legacy?.apiKey) {
    return {
      apiKey: legacy.apiKey,
      baseUrl: legacy.baseUrl,
      options: legacy.model ? { model: legacy.model } : undefined,
    };
  }

  return undefined;
}
