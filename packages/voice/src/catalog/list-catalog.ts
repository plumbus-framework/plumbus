import { deepFreeze } from '../internal/deep-freeze.js';
import type {
  VoiceProviderCatalog,
  VoiceStackSuggestion,
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
} from '../types/provider.js';
import { SONIOX_STT_REGISTRATION } from '../providers/stt/soniox-stt.js';
import { OPENAI_WHISPER_STT_REGISTRATION } from '../providers/stt/openai-whisper-stt.js';
import { OPENAI_REALTIME_STT_REGISTRATION } from '../providers/stt/openai-realtime-stt.js';
import { WEB_SPEECH_STT_REGISTRATION } from '../providers/stt/web-speech-stt.js';
import { DEEPDUB_TTS_REGISTRATION } from '../providers/tts/deepdub-tts.js';
import { OPENAI_TTS_REGISTRATION } from '../providers/tts/openai-tts.js';
import { MINIMAX_TTS_REGISTRATION } from '../providers/tts/minimax-tts.js';
import { ELEVENLABS_TTS_REGISTRATION } from '../providers/tts/elevenlabs-tts.js';
import { BROWSER_TTS_REGISTRATION } from '../providers/tts/browser-tts.js';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '../providers/transport/livekit-transport.js';
import { WEBSOCKET_TRANSPORT_REGISTRATION } from '../providers/transport/websocket-transport.js';

export const BUILTIN_TRANSPORT_PROVIDERS = deepFreeze([
  LIVEKIT_TRANSPORT_REGISTRATION.descriptor,
  WEBSOCKET_TRANSPORT_REGISTRATION.descriptor,
]);

export const BUILTIN_STT_PROVIDERS: readonly STTProviderCatalogEntry[] = deepFreeze([
  SONIOX_STT_REGISTRATION.descriptor,
  OPENAI_WHISPER_STT_REGISTRATION.descriptor,
  OPENAI_REALTIME_STT_REGISTRATION.descriptor,
  WEB_SPEECH_STT_REGISTRATION.descriptor,
]);

export const BUILTIN_TTS_PROVIDERS: readonly TTSProviderCatalogEntry[] = deepFreeze([
  DEEPDUB_TTS_REGISTRATION.descriptor,
  OPENAI_TTS_REGISTRATION.descriptor,
  MINIMAX_TTS_REGISTRATION.descriptor,
  ELEVENLABS_TTS_REGISTRATION.descriptor,
  BROWSER_TTS_REGISTRATION.descriptor,
]);

const STATIC_VOICE_PROVIDER_CATALOG: VoiceProviderCatalog = deepFreeze({
  transport: [...BUILTIN_TRANSPORT_PROVIDERS],
  stt: [...BUILTIN_STT_PROVIDERS],
  tts: [...BUILTIN_TTS_PROVIDERS],
});

const VOICE_STACK_SUGGESTIONS: readonly VoiceStackSuggestion[] = deepFreeze([
  {
    id: 'hebrew-production',
    transport: 'livekit',
    stt: 'soniox',
    tts: 'deepdub',
    useCase: 'Reference Hebrew stack',
  },
  {
    id: 'hebrew-minimax-eval',
    transport: 'websocket',
    stt: 'openai-whisper',
    tts: 'minimax',
    useCase: 'MiniMax Hebrew evaluation stack',
  },
  {
    id: 'english-dev',
    transport: 'websocket',
    stt: 'openai-realtime',
    tts: 'openai',
    useCase: 'Local development without LiveKit',
  },
  {
    id: 'browser-dev',
    transport: 'websocket',
    stt: 'web-speech',
    tts: 'openai',
    useCase: 'Chrome desktop dev with zero STT keys',
  },
  {
    id: 'batch-eval',
    transport: 'websocket',
    stt: 'openai-whisper',
    tts: 'openai',
    useCase: 'Offline harness for batch evaluation',
  },
  {
    id: 'local-sidecar-stt',
    transport: 'websocket',
    stt: 'openai-whisper',
    tts: 'openai',
    useCase: 'OpenAI-compatible local Whisper sidecar',
  },
  {
    id: 'fully-local-browser',
    transport: 'websocket',
    stt: 'web-speech',
    tts: 'browser-tts',
    useCase: 'Zero-cloud browser-local development',
  },
]);

export function listVoiceProviderCatalog(): VoiceProviderCatalog {
  return STATIC_VOICE_PROVIDER_CATALOG;
}

export function suggestVoiceStacks(): readonly VoiceStackSuggestion[] {
  return VOICE_STACK_SUGGESTIONS;
}
