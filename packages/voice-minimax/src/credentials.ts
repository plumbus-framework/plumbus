import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export function resolveCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): VoiceProviderCredentials {
  const groupId = env.MINIMAX_GROUP_ID;
  return {
    apiKey: env.MINIMAX_API_KEY,
    baseUrl: env.MINIMAX_BASE_URL,
    options: typeof groupId === 'string' && groupId.length > 0 ? { groupId } : undefined,
  };
}
