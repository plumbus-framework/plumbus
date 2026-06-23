import type { AccessPolicy, ExecutionContext } from '@plumbus/core';
import type { VoiceNoiseCancellationConfig } from './noise-cancellation.js';

export type ToneProfileId = string;

export interface DeliveryTone {
  profile?: ToneProfileId;
  pace?: 'slow' | 'normal' | 'fast';
  warmth?: 'low' | 'medium' | 'high';
  energy?: 'low' | 'medium' | 'high';
  emotion?: string;
  /**
   * Preferred speaker gender for this turn's synthesis. Lets a per-turn
   * `resolveTone` hook drive the voice gender dynamically (e.g. from a detected
   * subject gender). Providers that support a gender control (Deepdub) prefer
   * this over their static voice option; providers that don't simply ignore it.
   */
  targetGender?: string;
}

export interface VoiceTransportConfig {
  provider: string;
  mode?: string;
  audioFormat?: string;
  options?: Record<string, unknown> & {
    noiseCancellation?: VoiceNoiseCancellationConfig;
  };
}

export interface VoiceSttConfig {
  provider: string;
  model?: string;
  languages?: string[];
  options?: Record<string, unknown>;
}

export interface VoiceTtsConfig {
  provider: string;
  model?: string;
  voiceId?: string;
  locale?: string;
  options?: Record<string, unknown>;
}

export interface VoiceBrainRunArgs {
  transcript?: string;
  language?: string;
  sessionId?: string;
  input?: Record<string, unknown>;
  onAssistantDelta?: (text: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface VoiceBrain {
  run: (ctx: ExecutionContext, args: VoiceBrainRunArgs) => Promise<unknown> | unknown;
}

export interface VoiceResolveToneArgs {
  userTranscript?: string;
  language?: string;
  sessionId?: string;
}

export type VoiceResolveToneResult = ToneProfileId | DeliveryTone | undefined;

export interface VoiceConfig {
  name: string;
  description?: string;
  access: AccessPolicy;
  transport: VoiceTransportConfig;
  stt: VoiceSttConfig;
  tts: VoiceTtsConfig;
  brain: VoiceBrain;
  instructions?: string[];
  toneProfiles?: Record<ToneProfileId, DeliveryTone>;
  resolveTone?: (
    ctx: ExecutionContext,
    args: VoiceResolveToneArgs,
  ) => Promise<VoiceResolveToneResult> | VoiceResolveToneResult;
  preprocessForTts?: (text: string, ctx: ExecutionContext) => Promise<string> | string;
}

export interface VoiceDefinition extends VoiceConfig {
  kind: 'voice';
  instructions: string[];
  toneProfiles: Record<ToneProfileId, DeliveryTone>;
}
