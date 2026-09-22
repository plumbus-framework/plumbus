import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceProviderCredentials {
  return {
    apiKey: env.DEEPDUB_API_KEY,
    baseUrl: env.DEEPDUB_BASE_URL,
  };
}
