export * from './types/index.js';
export { defineVoice } from './define/defineVoice.js';

export type {
  ProviderDescriptor,
  STTProviderCapabilities,
  TTSProviderCapabilities,
  TransportProviderCapabilities,
} from './providers/base/capabilities.js';
export type { STTProvider } from './providers/base/stt-provider.js';
export type { TTSProvider } from './providers/base/tts-provider.js';
export type { TransportProvider } from './providers/base/transport-provider.js';

export {
  BUILTIN_STT_PROVIDERS,
  BUILTIN_TTS_PROVIDERS,
  BUILTIN_TRANSPORT_PROVIDERS,
  listVoiceProviderCatalog,
  suggestVoiceStacks,
} from './catalog/list-catalog.js';
export { fetchVoiceProviderOptions } from './catalog/fetch-options.js';
export {
  createProviderRegistry,
  validateVoiceProviders,
} from './providers/registry.js';
export {
  createSTTProvider,
  createTTSProvider,
  createTransportProvider,
} from './providers/factory.js';
export { runVoiceTurn } from './runtime/run-turn.js';
export { registerVoiceRoutes } from './runtime/http.js';
export type { RegisterVoiceRoutesOpts, VoiceBeforeSessionResult } from './types/http.js';
export {
  startVoiceWorker,
  joinVoiceRoomSession,
} from './runtime/worker.js';
export type {
  StartVoiceWorkerOptions,
  VoiceWorkerHandle,
  JoinVoiceRoomSessionOptions,
  VoiceRoomSessionHandle,
} from './runtime/worker.js';
export { createVoiceExecutionContext } from './runtime/create-voice-execution-context.js';
export {
  createVoiceAgentEntry,
  stopActiveVoiceAgentSessions,
  startVoiceAgentWorker,
  bootstrapVoiceAgentConfigsFromModule,
  PLUMBUS_VOICE_AGENT_BOOTSTRAP_MODULE_ENV,
} from './runtime/livekit-agent-worker.js';
export { runStreamingTurnPipeline } from './runtime/streaming-turn-pipeline.js';
export { stripVoiceAssistantMarkers } from './runtime/assistant-text.js';
export { mintLiveKitParticipantToken } from './providers/transport/livekit-transport.js';
export { discoverVoices } from './discover/discover-voices.js';
export { resolveVoiceProvidersFromEnv } from './config/resolve-voice-providers.js';
export { resolveVoiceOpenAICredentials } from './config/resolve-openai-credentials.js';
export {
  applyDeliveryToneToText,
  mapDeliveryToneForProvider,
} from './runtime/tone-mapper.js';
export * from './cost/index.js';
