import type { TTSProvider } from '../providers/base/tts-provider.js';
import type { TransportProvider } from '../providers/base/transport-provider.js';
import type { VoiceEvent } from '../types/event.js';
import { createAgentStateEvent } from './events.js';

export type HearingRepairReason = 'empty' | 'uncertain_name';

export interface HearingRepairAssessment {
  needed: boolean;
  reason?: HearingRepairReason;
  prompt?: string;
}

export type HearingRepairTrigger = 'endpoint' | 'final';

const REPAIR_PROMPTS = {
  he: {
    empty: 'לא הצלחתי לשמוע את זה ברור. אפשר לחזור שוב?',
    uncertain_name: 'אפשר לאיית את השם?',
  },
  en: {
    empty: "I didn't catch that clearly. Could you say it again?",
    uncertain_name: 'Could you spell the name for me?',
  },
} as const;

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
  const prompts = REPAIR_PROMPTS[language];
  const threshold = args.lowConfidenceThreshold ?? 0.55;

  if (!text) {
    if (args.trigger === 'endpoint' && args.hadSpeechEnergy) {
      return { needed: true, reason: 'empty', prompt: prompts.empty };
    }
    return { needed: false };
  }

  const confidence = args.confidence;
  if (confidence !== undefined && confidence < threshold && looksLikeUncertainProperName(text)) {
    return { needed: true, reason: 'uncertain_name', prompt: prompts.uncertain_name };
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

function looksLikeUncertainProperName(text: string): boolean {
  const hasHebrew = /[\u0590-\u05FF]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (hasHebrew && hasLatin) {
    return true;
  }

  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const word = words[0] ?? '';
    if (/^[A-Z][a-z]+(?:-[A-Z][a-z]+)?$/.test(word)) {
      return true;
    }
    if (/^[A-Z]{2,}$/.test(word)) {
      return true;
    }
  }

  return false;
}
