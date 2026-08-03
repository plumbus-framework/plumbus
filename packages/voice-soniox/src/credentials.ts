import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceProviderCredentials {
  return {
    apiKey: env.SONIOX_API_KEY,
    baseUrl: env.SONIOX_BASE_URL,
  };
}
