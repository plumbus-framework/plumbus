import type { VoiceProvidersConfig } from '../types/provider.js';

/**
 * Resolves credentials for **builtin** voice providers only
 * (`websocket`, `web-speech`, `browser-tts`).
 * Cloud/vendor credentials come from each `@plumbus/voice-*` package
 * (or explicit `voice.providers` / `app/voice/registry.ts`).
 */
export function resolveVoiceProviders(
  config: { voice?: { providers?: VoiceProvidersConfig['providers'] } } = {},
): VoiceProvidersConfig {
  const configured = config.voice?.providers ?? {};

  return {
    providers: {
      websocket: configured.websocket ?? {},
      'web-speech': configured['web-speech'] ?? {},
      'browser-tts': configured['browser-tts'] ?? {},
      ...configured,
    },
  };
}

export function resolveVoiceProvidersFromEnv(
  config: Parameters<typeof resolveVoiceProviders>[0] = {},
): VoiceProvidersConfig {
  return resolveVoiceProviders(config);
}
