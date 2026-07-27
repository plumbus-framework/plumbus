import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceProviderCredentials {
  return {
    apiKey: env.ELEVENLABS_API_KEY,
    baseUrl: env.ELEVENLABS_BASE_URL,
  };
}
