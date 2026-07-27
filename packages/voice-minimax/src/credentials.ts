import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceProviderCredentials {
  return {
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
  };
}
