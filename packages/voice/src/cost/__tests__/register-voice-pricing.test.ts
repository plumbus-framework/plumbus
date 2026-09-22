import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
} from '../../providers/base/provider-registration.js';
import { createProviderRegistry } from '../../providers/registry.js';
import { recordVoiceCost } from '../record-voice-cost.js';
import {
  calculateVoiceCost,
  lookupVoicePricing,
  registerVoicePricing,
  resetRegisteredVoicePricing,
} from '../voice-pricing.js';

const sonioxPricing = {
  model: 'soniox-stt',
  operation: 'transcribe' as const,
  unit: 'audioInputSeconds' as const,
  usdPerUnit: 0.0001667,
};

const deepdubPricing = {
  model: 'deepdub-phantom-x',
  operation: 'synthesize' as const,
  unit: 'characters' as const,
  usdPerUnit: 0.000024,
};

const mockSttRegistration: STTProviderRegistration = {
  descriptor: {
    id: 'soniox',
    kind: 'stt',
    displayName: 'Soniox',
    credentialSchema: [],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    languages: 'multilingual',
    knownModels: [
      { id: 'stt-rt-v5', displayName: 'v5', streaming: true, costModelKey: 'soniox-stt' },
    ],
  },
  pricing: sonioxPricing,
  create() {
    return {
      capabilities: mockSttRegistration.descriptor,
      connect: async () => {},
    };
  },
};

const mockTtsRegistration: TTSProviderRegistration = {
  descriptor: {
    id: 'deepdub',
    kind: 'tts',
    displayName: 'Deepdub',
    credentialSchema: [],
    hosting: 'cloud',
    execution: 'server',
    streaming: true,
    toneSupport: 'full',
    deliveryAxes: [],
    deliveryMode: 'native-params',
    knownModels: [
      { id: 'dd-etts-3.2', displayName: '3.2', streaming: true, costModelKey: 'deepdub-phantom-x' },
    ],
    voicesSource: 'live-api',
  },
  pricing: deepdubPricing,
  create() {
    return {
      capabilities: mockTtsRegistration.descriptor,
      mapDeliveryTone: () => ({}),
    };
  },
};

describe('registerVoicePricing', () => {
  afterEach(() => {
    resetRegisteredVoicePricing();
  });

  it('registers pricing from createProviderRegistry registrations', () => {
    createProviderRegistry({
      stt: { soniox: mockSttRegistration },
      tts: { deepdub: mockTtsRegistration },
    });

    expect(lookupVoicePricing('soniox-stt')).toEqual(sonioxPricing);
    expect(lookupVoicePricing('deepdub-phantom-x')).toEqual(deepdubPricing);
    expect(calculateVoiceCost('soniox-stt', { audioInputSeconds: 22 })).toBeCloseTo(0.003667, 5);
    expect(calculateVoiceCost('deepdub-phantom-x', { characters: 49 })).toBeCloseTo(0.001176, 5);
  });

  it('lets recordVoiceCost compute USD for registered add-on models', async () => {
    registerVoicePricing([sonioxPricing, deepdubPricing]);
    const recordProviderCost = vi.fn(async () => {});

    const stt = await recordVoiceCost(
      { ai: { recordProviderCost } },
      {
        operation: 'transcribe',
        provider: 'soniox',
        model: 'soniox-stt',
        mediaUsage: { audioInputSeconds: 22 },
        latencyMs: 0,
      },
    );
    const tts = await recordVoiceCost(
      { ai: { recordProviderCost } },
      {
        operation: 'synthesize',
        provider: 'deepdub',
        model: 'deepdub-phantom-x',
        mediaUsage: { characters: 49 },
        latencyMs: 0,
      },
    );

    expect(stt.pricingKnown).toBe(true);
    expect(stt.cost).toBeCloseTo(0.003667, 5);
    expect(tts.pricingKnown).toBe(true);
    expect(tts.cost).toBeCloseTo(0.001176, 5);
  });

  it('estimates audio seconds from characters for per-minute-audio pricing', () => {
    // Direct-utterance paths (hearing repair, replay) know the text but not the
    // audio duration; vendors billed per minute of generated audio publish
    // ~1,000 characters ≈ 1 minute of speech.
    registerVoicePricing({
      model: 'deepdub-phantom-x',
      operation: 'synthesize',
      unit: 'audioOutputSeconds',
      usdPerUnit: 0.1 / 60,
    });

    // 2,000 characters ≈ 2 minutes = 120 seconds.
    expect(calculateVoiceCost('deepdub-phantom-x', { characters: 2000 })).toBeCloseTo(0.2, 5);
    // An exact duration always wins over the estimate.
    expect(
      calculateVoiceCost('deepdub-phantom-x', { audioOutputSeconds: 60, characters: 2000 }),
    ).toBeCloseTo(0.1, 5);
  });
});
