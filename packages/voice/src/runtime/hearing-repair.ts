import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import type { VoiceEvent } from '../types/event.js';
import type { VoiceHearingRepairReason } from '../types/voice.js';
import { createAgentStateEvent } from './events.js';

export type HearingRepairReason = VoiceHearingRepairReason;

export interface HearingRepairAssessment {
  needed: boolean;
  reason?: HearingRepairReason;
  prompt?: string;
}

export type HearingRepairTrigger = 'endpoint' | 'final';

const REPAIR_PROMPTS = {
  he: {
    empty: 'לא הצלחתי לשמוע את זה ברור. אפשר לחזור שוב?',
  },
  en: {
    empty: "I didn't catch that clearly. Could you say it again?",
  },
} as const;

/**
 * Signal-level hearing-repair detection. The framework reports *that* an
 * utterance may need repair ('empty' after speech energy, or 'low_confidence'
 * below the threshold) — never *what* the transcript is. Content judgment
 * (and all repair text beyond the built-in 'empty' default) belongs to the
 * app's `onHearingRepair` hook.
 */
export function assessHearingRepairNeeded(args: {
  transcript?: string;
  confidence?: number;
  language?: string;
  lowConfidenceThreshold?: number;
  hadSpeechEnergy?: boolean;
  trigger?: HearingRepairTrigger;
}): HearingRepairAssessment {
  const text = (args.transcript ?? '').trim();
  const language = resolveRepairLanguage(args.language);
  const threshold = args.lowConfidenceThreshold ?? 0.55;

  if (!text) {
    if (args.trigger === 'endpoint' && args.hadSpeechEnergy) {
      return { needed: true, reason: 'empty', prompt: REPAIR_PROMPTS[language].empty };
    }
    return { needed: false };
  }

  const confidence = args.confidence;
  if (confidence !== undefined && confidence < threshold) {
    // No prompt: the framework does not guess what a low-confidence
    // transcript contains. The app hook decides whether to repair and what
    // to say; without a hook this assessment produces no repair speech.
    return { needed: true, reason: 'low_confidence' };
  }

  return { needed: false };
}

export async function speakDirectUtterance(args: {
  text: string;
  ttsProvider: TTSProvider;
  transportProvider: TransportProvider;
  onEvent?: (event: VoiceEvent) => void | Promise<void>;
  onAudioChunk?: (chunk: Uint8Array) => void | Promise<void>;
  abortSignal?: AbortSignal;
  ttsParams?: unknown;
  /** When false, skip assistant.delta and tts.speak (audio-only continuers). Default true. */
  emitAssistantText?: boolean;
  /** When false, do not emit agent.state Playing (UI stays in Listening). Default true. */
  announcePlaying?: boolean;
}): Promise<void> {
  const emitAssistantText = args.emitAssistantText !== false;
  const announcePlaying = args.announcePlaying !== false;

  if (emitAssistantText) {
    await args.onEvent?.({ type: 'assistant.delta', text: args.text });
    await args.onEvent?.({ type: 'tts.speak', text: args.text });
  }

  if (!args.ttsProvider.synthesizeStream) {
    if (announcePlaying) {
      await args.onEvent?.(createAgentStateEvent('Playing'));
    }
    return;
  }

  let playingEmitted = false;
  for await (const audioChunk of args.ttsProvider.synthesizeStream(
    args.text,
    args.ttsParams ?? {},
    args.abortSignal,
  )) {
    if (args.abortSignal?.aborted) {
      return;
    }
    if (announcePlaying && !playingEmitted) {
      await args.onEvent?.(createAgentStateEvent('Playing'));
      playingEmitted = true;
    }
    await args.onAudioChunk?.(audioChunk);
    await args.transportProvider.publishAudio?.(audioChunk);
  }
}

function resolveRepairLanguage(language?: string): keyof typeof REPAIR_PROMPTS {
  return language?.toLowerCase().startsWith('en') ? 'en' : 'he';
}
