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
   * Per-turn voice override for this delivery (e.g. a Deepdub `voicePromptId`
   * selecting an emotional style variant of the same speaker). Providers that
   * support per-call voice selection prefer this over the static
   * `tts.voiceId`; providers that don't simply ignore it.
   */
  voiceId?: string;
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

/** Why the session controller decided the user's speech may need a repair prompt. */
export type VoiceHearingRepairReason = 'empty' | 'low_confidence';

export interface VoiceHearingRepairArgs {
  /**
   * What triggered the repair signal: 'empty' (endpoint with no transcript
   * after speech energy) or 'low_confidence' (transcript below the configured
   * confidence threshold). The framework reports signals only — judging what
   * the transcript *is* (a name, a mumble, a language switch) is app content.
   */
  reason: VoiceHearingRepairReason;
  /** Raw transcript that triggered the signal ('low_confidence' only). */
  transcript?: string;
  /** Provider-reported confidence that triggered the signal ('low_confidence' only). */
  confidence?: number;
  /** Detected language of the utterance being repaired (session language fallback). */
  language?: string;
  sessionId: string;
}

export interface VoiceHearingRepairUtterance {
  /** The exact text spoken back to the user. The app owns this content. */
  text: string;
  /**
   * Optional delivery tone for the repair utterance. Resolved against the
   * voice's toneProfiles and mapped through the TTS provider's
   * `mapDeliveryTone`, exactly like a brain-turn tone — the framework passes
   * the result to synthesis without interpreting it.
   */
  tone?: VoiceResolveToneResult;
}

/**
 * Return value of the `onHearingRepair` hook:
 * - a string, or `{ text, tone? }`: speak this repair utterance;
 * - `undefined`/`null`: suppress the repair speech entirely.
 */
export type VoiceHearingRepairResult = string | VoiceHearingRepairUtterance | undefined | null;

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
  /**
   * App-owned hearing-repair content. The framework keeps the mechanism
   * (signal detection, timing, playback, cost recording); this hook owns what
   * is said — and, for `low_confidence`, whether anything is said at all.
   * Called when the controller detects an empty utterance after speech energy
   * or a transcript below the confidence threshold. Return the text to speak
   * (optionally with a delivery `tone`), or `undefined`/`null` to suppress the
   * repair speech (a suppressed `low_confidence` repair lets the turn proceed
   * normally). Without the hook, `empty` keeps the framework's built-in
   * default line while `low_confidence` produces no repair — the framework
   * never judges transcript content on its own.
   */
  onHearingRepair?: (
    ctx: ExecutionContext,
    args: VoiceHearingRepairArgs,
  ) => Promise<VoiceHearingRepairResult> | VoiceHearingRepairResult;
  preprocessForTts?: (text: string, ctx: ExecutionContext) => Promise<string> | string;
}

export interface VoiceDefinition extends VoiceConfig {
  kind: 'voice';
  instructions: string[];
  toneProfiles: Record<ToneProfileId, DeliveryTone>;
}
