import { deepFreeze } from '../internal/deep-freeze.js';
import type {
  VoiceProviderCatalog,
  VoiceStackSuggestion,
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
} from '../types/provider.js';
import { WEB_SPEECH_STT_REGISTRATION } from '../providers/stt/web-speech-stt.js';
import { BROWSER_TTS_REGISTRATION } from '../providers/tts/browser-tts.js';
import { WEBSOCKET_TRANSPORT_REGISTRATION } from '../providers/transport/websocket-transport.js';
import type { VoiceProviderRegistry } from '../providers/registry.js';

export const BUILTIN_TRANSPORT_PROVIDERS = deepFreeze([
  WEBSOCKET_TRANSPORT_REGISTRATION.descriptor,
]);

export const BUILTIN_STT_PROVIDERS: readonly STTProviderCatalogEntry[] = deepFreeze([
  WEB_SPEECH_STT_REGISTRATION.descriptor,
]);

export const BUILTIN_TTS_PROVIDERS: readonly TTSProviderCatalogEntry[] = deepFreeze([
  BROWSER_TTS_REGISTRATION.descriptor,
]);

const STATIC_VOICE_PROVIDER_CATALOG: VoiceProviderCatalog = deepFreeze({
  transport: [...BUILTIN_TRANSPORT_PROVIDERS],
  stt: [...BUILTIN_STT_PROVIDERS],
  tts: [...BUILTIN_TTS_PROVIDERS],
});

const VOICE_STACK_SUGGESTIONS: readonly VoiceStackSuggestion[] = deepFreeze([
  {
    id: 'browser-dev',
    transport: 'websocket',
    stt: 'web-speech',
    tts: 'browser-tts',
    useCase: 'Chrome desktop dev with zero cloud keys',
  },
  {
    id: 'fully-local-browser',
    transport: 'websocket',
    stt: 'web-speech',
    tts: 'browser-tts',
    useCase: 'Zero-cloud browser-local development',
  },
]);

/** Built-in catalog only. Pass a registry to include installed add-on descriptors. */
export function listVoiceProviderCatalog(registry?: VoiceProviderRegistry): VoiceProviderCatalog {
  if (!registry) {
    return STATIC_VOICE_PROVIDER_CATALOG;
  }

  const transport = [
    ...BUILTIN_TRANSPORT_PROVIDERS,
    ...[...registry.transport.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !BUILTIN_TRANSPORT_PROVIDERS.some((b) => b.id === descriptor.id)),
  ];
  const stt = [
    ...BUILTIN_STT_PROVIDERS,
    ...[...registry.stt.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !BUILTIN_STT_PROVIDERS.some((b) => b.id === descriptor.id)),
  ];
  const tts = [
    ...BUILTIN_TTS_PROVIDERS,
    ...[...registry.tts.values()]
      .map((entry) => entry.descriptor)
      .filter((descriptor) => !BUILTIN_TTS_PROVIDERS.some((b) => b.id === descriptor.id)),
  ];

  return deepFreeze({ transport, stt, tts });
}

export function suggestVoiceStacks(): readonly VoiceStackSuggestion[] {
  return VOICE_STACK_SUGGESTIONS;
}
