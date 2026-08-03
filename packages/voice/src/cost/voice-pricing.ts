import type { VoiceMediaUsage } from '../types/cost.js';

export type VoicePricingUnit =
  | 'audioInputSeconds'
  | 'audioInputMinutes'
  | 'audioOutputSeconds'
  | 'characters'
  | 'connectionMinutes'
  | 'participantMinutes';

export interface VoicePricingEntry {
  model: string;
  operation: 'transcribe' | 'synthesize' | 'transport';
  unit: VoicePricingUnit;
  usdPerUnit: number;
}

/** Built-in websocket pricing only. Cloud/vendor pricing is registered from `@plumbus/voice-*`. */
const BUILTIN_VOICE_PRICING: Readonly<Record<string, VoicePricingEntry>> = {
  websocket: {
    model: 'websocket',
    operation: 'transport',
    unit: 'participantMinutes',
    usdPerUnit: 0,
  },
};

/** Populated by `createProviderRegistry()` from each registration's `pricing` field. */
let registeredVoicePricing: Record<string, VoicePricingEntry> = {};

/**
 * Merge add-on pricing rows into the runtime lookup used by `calculateVoiceCost` /
 * `recordVoiceCost`. Prefer attaching `pricing` on `*_REGISTRATION` so
 * `createProviderRegistry()` registers them automatically.
 */
export function registerVoicePricing(
  entries: VoicePricingEntry | readonly VoicePricingEntry[],
): void {
  const list = Array.isArray(entries) ? entries : [entries];
  for (const entry of list) {
    registeredVoicePricing[entry.model] = entry;
  }
}

/** Test helper — clears add-on pricing without touching builtins. */
export function resetRegisteredVoicePricing(): void {
  registeredVoicePricing = {};
}

export function listVoicePricing(): readonly VoicePricingEntry[] {
  return [...Object.values(BUILTIN_VOICE_PRICING), ...Object.values(registeredVoicePricing)];
}

export function lookupVoicePricing(model: string): VoicePricingEntry | undefined {
  return registeredVoicePricing[model] ?? BUILTIN_VOICE_PRICING[model];
}

export function calculateVoiceCost(model: string, mediaUsage: VoiceMediaUsage): number {
  const pricing = lookupVoicePricing(model);
  if (!pricing) {
    return 0;
  }

  const quantity = resolveUsageQuantity(pricing.unit, mediaUsage);
  if (quantity <= 0) {
    return 0;
  }

  return roundUsd(quantity * pricing.usdPerUnit);
}

function resolveUsageQuantity(unit: VoicePricingUnit, mediaUsage: VoiceMediaUsage): number {
  switch (unit) {
    case 'audioInputSeconds':
      return mediaUsage.audioInputSeconds ?? 0;
    case 'audioInputMinutes':
      return (mediaUsage.audioInputSeconds ?? 0) / 60;
    case 'audioOutputSeconds':
      return mediaUsage.audioOutputSeconds ?? 0;
    case 'characters':
      return mediaUsage.characters ?? 0;
    case 'connectionMinutes':
      return mediaUsage.connectionMinutes ?? 0;
    case 'participantMinutes':
      return mediaUsage.participantMinutes ?? 0;
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
