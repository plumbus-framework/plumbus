import type { VoiceProvidersConfig } from '../types/provider.js';
import { resolveVoiceOpenAICredentials } from '../config/resolve-openai-credentials.js';

export function resolveVoiceProviders(
  config: {
    voice?: { providers?: VoiceProvidersConfig['providers'] };
    aiProviders?: {
      providers?: { openai?: { apiKey?: string; baseUrl?: string; model?: string } };
    };
    ai?: { apiKey?: string; baseUrl?: string; model?: string };
  } = {},
): VoiceProvidersConfig {
  const voiceConfig = config.voice;
  const configured = voiceConfig?.providers ?? {};

  const openai = resolveVoiceOpenAICredentials(
    config as Parameters<typeof resolveVoiceOpenAICredentials>[0],
  );
  const env = process.env;

  return {
    providers: {
      websocket: configured.websocket ?? {},
      'web-speech': configured['web-speech'] ?? {},
      'browser-tts': configured['browser-tts'] ?? {},
      livekit: configured.livekit ?? {
        url: env.LIVEKIT_URL,
        apiKey: env.LIVEKIT_API_KEY,
        apiSecret: env.LIVEKIT_API_SECRET,
      },
      soniox: configured.soniox ?? {
        apiKey: env.SONIOX_API_KEY,
        baseUrl: env.SONIOX_BASE_URL,
      },
      deepdub: configured.deepdub ?? {
        apiKey: env.DEEPDUB_API_KEY,
        baseUrl: env.DEEPDUB_BASE_URL,
      },
      openai: configured.openai ?? openai ?? {},
      'openai-whisper': configured['openai-whisper'] ?? openai ?? {},
      'openai-realtime': configured['openai-realtime'] ?? openai ?? {},
      minimax: configured.minimax ?? {
        apiKey: env.MINIMAX_API_KEY,
        baseUrl: env.MINIMAX_BASE_URL,
      },
      elevenlabs: configured.elevenlabs ?? {
        apiKey: env.ELEVENLABS_API_KEY,
        baseUrl: env.ELEVENLABS_BASE_URL,
      },
      ...configured,
    },
  };
}

export function resolveVoiceProvidersFromEnv(
  config: Parameters<typeof resolveVoiceProviders>[0] = {},
): VoiceProvidersConfig {
  return resolveVoiceProviders(config);
}
