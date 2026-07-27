/**
 * Narrow kit surface for `@plumbus/voice-*` add-on packages.
 * Add-ons should import from `@plumbus/voice/provider-kit`, not deep paths.
 * Vendor descriptors/models/pricing live in each `@plumbus/voice-*` package — not here.
 */

export { getVoiceModelOption } from '../catalog/static-models.js';
export { createVoiceSessionBudget } from '../cost/session-budget.js';
export type {
  STTProviderCapabilities,
  TransportProviderCapabilities,
  TTSProviderCapabilities,
} from '../providers/base/capabilities.js';
export { fetchCatalogJson, normalizeVoiceList } from '../providers/base/catalog-http.js';
export type {
  STTProviderRegistration,
  TransportProviderRegistration,
  TTSProviderRegistration,
  VoiceCatalogFetch,
  VoiceProviderListContext,
} from '../providers/base/provider-registration.js';
export type {
  STTProvider,
  STTProviderAudioChunk,
  STTProviderConnectArgs,
  STTProviderTranscriptEvent,
} from '../providers/base/stt-provider.js';
export type {
  TransportProvider,
  TransportProviderMintSessionArgs,
  TransportProviderSession,
} from '../providers/base/transport-provider.js';
export type { TTSProvider } from '../providers/base/tts-provider.js';
export type {
  AudioFormatInfo,
  RuntimeFetch,
  RuntimeFetchResponse,
  RuntimeWebSocket,
  RuntimeWebSocketFactory,
} from '../providers/stt/shared.js';
export {
  concatAudioChunks,
  Deferred,
  estimateAudioSeconds,
  fileExtensionForContentType,
  parseAudioFormat,
  readOption,
  resolveHttpBaseUrl,
  resolveRuntimeFetch,
  resolveRuntimeWebSocketFactory,
  resolveWebSocketUrl,
  roundMetric,
  toBase64,
  toBlob,
  toBlobPart,
  toVendorAudioFormat,
  wrapPcm16AsWav,
} from '../providers/stt/shared.js';
export type { TTSFetch, TTSFetchResponse, TTSWebSocket } from '../providers/tts/wire.js';
export {
  assertOkResponse,
  decodeBase64Audio,
  decodeHexAudio,
  httpToWebSocketUrl,
  joinUrl,
  readResponseChunks,
  readResponseError,
  resolveTtsFetch,
  resolveTtsWebSocketFactory,
  socketMessageToString,
} from '../providers/tts/wire.js';
export {
  assertExclusiveNoiseCancellation,
  parseNoiseCancellation,
  readNoiseCancellationFromTransportOptions,
  serializeNoiseCancellation,
} from '../runtime/noise-cancellation/parse-noise-cancellation.js';
export type { VoiceSessionBudgetConfig } from '../types/cost.js';
export type { VoicePricingEntry } from '../cost/voice-pricing.js';
export type { VoiceEvent } from '../types/event.js';
export type {
  ResolvedNoiseCancellation,
  SerializedNoiseCancellation,
} from '../types/noise-cancellation.js';
export {
  NoiseCancellationEngine,
  NoiseCancellationModel,
  NoiseCancellationPlacement,
} from '../types/noise-cancellation.js';
export type {
  STTProviderCatalogEntry,
  TTSProviderCatalogEntry,
  VoiceModelOption,
  VoicePersonaOption,
  VoiceProviderCredentials,
  VoiceProvidersConfig,
} from '../types/provider.js';
export type {
  DeliveryTone,
  VoiceDefinition,
  VoiceSttConfig,
  VoiceTransportConfig,
  VoiceTtsConfig,
} from '../types/voice.js';
