import { describe, expect, it } from 'vitest';
import * as client from '../client/index.js';
import * as index from '../index.js';
import * as testing from '../testing/index.js';
import * as worker from '../worker.js';

/**
 * Hard-extract surface: cloud providers (including OpenAI) live on `@plumbus/voice-*`.
 */
const EXPECTED_INDEX_EXPORTS = [
  'BUILTIN_STT_PROVIDERS',
  'BUILTIN_TRANSPORT_PROVIDERS',
  'BUILTIN_TTS_PROVIDERS',
  'NoiseCancellationEngine',
  'NoiseCancellationModel',
  'NoiseCancellationPlacement',
  'VoiceSessionController',
  'applyDeliveryToneToText',
  'assertCloneSampleWithinLimit',
  'assertExclusiveNoiseCancellation',
  'calculateVoiceCost',
  'createProviderRegistry',
  'createSTTProvider',
  'createTTSProvider',
  'createTransportProvider',
  'createVoiceCloneProvider',
  'createVoiceExecutionContext',
  'createVoiceSessionBudget',
  'defineVoice',
  'discoverVoices',
  'estimateVoiceTurnCost',
  'fetchVoiceProviderOptions',
  'getVoiceCloneCapabilities',
  'listVoicePricing',
  'listVoiceProviderCatalog',
  'loadAppVoiceRegistry',
  'lookupVoicePricing',
  'mapDeliveryToneForProvider',
  'mergeRoomBrainInput',
  'parseNoiseCancellation',
  'readNoiseCancellationFromTransportOptions',
  'recordVoiceCost',
  'registerVoiceCloneRoutes',
  'registerVoicePricing',
  'registerVoiceRoutes',
  'resetRegisteredVoicePricing',
  'resolveSttCostModelKey',
  'resolveTtsCostModelKey',
  'resolveVoiceProvidersFromEnv',
  'runStreamingTurnPipeline',
  'runVoiceTurn',
  'serializeNoiseCancellation',
  'stripVoiceAssistantMarkers',
  'suggestVoiceStacks',
  'summarizeVoiceTurnCosts',
  'supportsVoiceCloning',
  'synthesizeWithVoiceReference',
  'validateVoiceProviders',
] as const;

const EXPECTED_TESTING_EXPORTS = [
  'createMockSTTProvider',
  'createMockTTSProvider',
  'createMockTransportProvider',
  'createVoiceTestContext',
  'hebrewTranscriptFixtures',
  'mockSTTProvider',
  'mockTTSProvider',
  'mockTransportProvider',
  'mockVoiceRuntime',
  'pcmSampleFrames',
] as const;

const EXPECTED_WORKER_EXPORTS = [
  'createVoiceExecutionContext',
  'discoverVoices',
  'resolveVoiceProvidersFromEnv',
] as const;

const EXPECTED_CLIENT_EXPORTS = [
  'createBrowserSpeechSynthesizer',
  'createWebSpeechRecognizer',
  'isWebSpeechAvailable',
] as const;

const FORBIDDEN_INDEX_EXPORTS = [
  'VOICE_ADDON_PACKAGES',
  'voiceAddonMissingHint',
  'voiceAddonPackageFor',
  'createRegistryForVoices',
  'resolveAddonCredentialsFromEnv',
  'resolveVoiceOpenAICredentials',
  'loadVoiceAddons',
  'getLoadedVoiceAddons',
  'startVoiceAgentWorker',
  'OPENAI_WHISPER_STT_REGISTRATION',
  'OPENAI_REALTIME_STT_REGISTRATION',
  'OPENAI_TTS_REGISTRATION',
  'LIVEKIT_TRANSPORT_DESCRIPTOR',
  'DEEPDUB_TTS_DESCRIPTOR',
  'SONIOX_STT_DESCRIPTOR',
  'ELEVENLABS_TTS_DESCRIPTOR',
  'MINIMAX_TTS_DESCRIPTOR',
] as const;

describe('public API surface', () => {
  it('keeps the @plumbus/voice main export surface', () => {
    expect(Object.keys(index).sort()).toEqual([...EXPECTED_INDEX_EXPORTS]);
  });

  it('does not export cloud provider APIs or soft-load helpers from @plumbus/voice', () => {
    for (const name of FORBIDDEN_INDEX_EXPORTS) {
      expect(Object.keys(index)).not.toContain(name);
    }
  });

  it('keeps the @plumbus/voice/worker export surface without LiveKit helpers', () => {
    expect(Object.keys(worker).sort()).toEqual([...EXPECTED_WORKER_EXPORTS]);
    expect(Object.keys(worker)).not.toContain('startVoiceAgentWorker');
    expect(Object.keys(worker)).not.toContain('joinVoiceRoomSession');
  });

  it('keeps the @plumbus/voice/client export surface without createLiveKitVoiceSession', () => {
    expect(Object.keys(client).sort()).toEqual([...EXPECTED_CLIENT_EXPORTS]);
    expect(Object.keys(client)).not.toContain('createLiveKitVoiceSession');
  });

  it('keeps the @plumbus/voice/testing export surface', () => {
    expect(Object.keys(testing).sort()).toEqual([...EXPECTED_TESTING_EXPORTS]);
  });
});
