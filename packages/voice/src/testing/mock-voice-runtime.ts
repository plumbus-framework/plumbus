import { createTestContext, mockAI } from '@plumbus/core/testing';
import type { TestContextOptions } from '@plumbus/core/testing';
import type { VoiceEvent } from '../types/event.js';
import type { RunVoiceTurnArgs } from '../runtime/run-turn.js';
import { runVoiceTurn } from '../runtime/run-turn.js';
import type { VoiceDefinition } from '../types/voice.js';
import { createProviderRegistry } from '../providers/registry.js';
import {
  createSTTProvider,
  createTTSProvider,
  createTransportProvider,
} from '../providers/factory.js';
import type { VoiceProvidersConfig } from '../types/provider.js';

interface RecordedVoiceCost {
  record: unknown;
  costContext: unknown;
}

export interface VoiceTestContextResult {
  ctx: ReturnType<typeof createTestContext>;
  recordedCosts: RecordedVoiceCost[];
}

export function createVoiceTestContext(
  options: TestContextOptions = {},
): VoiceTestContextResult {
  const recordedCosts: RecordedVoiceCost[] = [];
  const baseAi = options.ai ?? mockAI();
  const baseAiRecordProviderCost =
    typeof baseAi === 'object' &&
    baseAi !== null &&
    'recordProviderCost' in baseAi &&
    typeof baseAi.recordProviderCost === 'function'
      ? baseAi.recordProviderCost.bind(baseAi)
      : undefined;
  const upstreamRecordProviderCost =
    baseAiRecordProviderCost;

  const ctx = createTestContext({
    ...options,
    ai: {
      ...baseAi,
      async recordProviderCost(record: unknown, costContext?: unknown) {
        recordedCosts.push({ record, costContext });
        await upstreamRecordProviderCost?.(record as never, costContext as never);
      },
    },
  });

  return {
    ctx,
    recordedCosts,
  };
}

export interface MockVoiceRuntimeOptions
  extends Omit<RunVoiceTurnArgs, 'voiceDefinition' | 'sessionId'> {
  sessionId?: string;
  contextOptions?: TestContextOptions;
  providers?: VoiceProvidersConfig;
  registry?: ReturnType<typeof createProviderRegistry>;
}

export async function mockVoiceRuntime(
  voiceDefinition: VoiceDefinition,
  options: MockVoiceRuntimeOptions = {},
): Promise<VoiceTestContextResult & { events: VoiceEvent[]; audioChunks: Uint8Array[] }> {
  const { ctx, recordedCosts } = createVoiceTestContext(options.contextOptions);
  const events: VoiceEvent[] = [];
  const audioChunks: Uint8Array[] = [];
  const registry = options.registry ?? createProviderRegistry();
  const providers = options.providers ?? { providers: {} };

  const sttProvider =
    options.sttProvider ??
    createSTTProvider({
      registry,
      providers,
      voiceSlice: voiceDefinition.stt,
    });
  const ttsProvider =
    options.ttsProvider ??
    createTTSProvider({
      registry,
      providers,
      voiceSlice: voiceDefinition.tts,
    });
  const transportProvider =
    options.transportProvider ??
    createTransportProvider({
      registry,
      providers,
      voiceSlice: voiceDefinition.transport,
    });

  for await (const event of runVoiceTurn(ctx, {
    ...options,
    voiceDefinition,
    sessionId: options.sessionId ?? 'voice-test-session',
    sttProvider,
    ttsProvider,
    transportProvider,
    onAudioChunk: async (chunk) => {
      audioChunks.push(chunk);
      await options.onAudioChunk?.(chunk);
    },
  })) {
    events.push(event);
  }

  return {
    ctx,
    recordedCosts,
    events,
    audioChunks,
  };
}
