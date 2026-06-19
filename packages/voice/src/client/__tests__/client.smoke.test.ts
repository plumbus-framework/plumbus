import { afterEach, describe, expect, it, vi } from 'vitest';
import * as voice from '../../index.js';
import {
  createBrowserSpeechSynthesizer,
  createWebSpeechRecognizer,
  isWebSpeechAvailable,
} from '../index.js';

const originalGlobals = {
  SpeechRecognition: globalThis.SpeechRecognition,
  webkitSpeechRecognition: (globalThis as typeof globalThis & { webkitSpeechRecognition?: unknown })
    .webkitSpeechRecognition,
  speechSynthesis: (globalThis as typeof globalThis & { speechSynthesis?: unknown })
    .speechSynthesis,
  SpeechSynthesisUtterance: (
    globalThis as typeof globalThis & {
      SpeechSynthesisUtterance?: unknown;
    }
  ).SpeechSynthesisUtterance,
};

afterEach(() => {
  vi.restoreAllMocks();
  restoreGlobal('SpeechRecognition', originalGlobals.SpeechRecognition);
  restoreGlobal('webkitSpeechRecognition', originalGlobals.webkitSpeechRecognition);
  restoreGlobal('speechSynthesis', originalGlobals.speechSynthesis);
  restoreGlobal('SpeechSynthesisUtterance', originalGlobals.SpeechSynthesisUtterance);
});

describe('voice client smoke', () => {
  it('re-exports the documented server runtime surface from the main barrel', () => {
    expect(typeof voice.defineVoice).toBe('function');
    expect(typeof voice.runVoiceTurn).toBe('function');
    expect(typeof voice.registerVoiceRoutes).toBe('function');
    expect(typeof voice.startVoiceWorker).toBe('function');
  });

  it('wraps the Web Speech API when a browser recognizer is available', () => {
    let recognitionInstance: MockSpeechRecognition | undefined;

    class MockSpeechRecognition {
      continuous?: boolean;
      interimResults?: boolean;
      lang?: string;
      maxAlternatives?: number;
      onresult?: (event: unknown) => void;
      onerror?: (event: { error?: string }) => void;
      start = vi.fn();
      stop = vi.fn();
      abort = vi.fn();

      constructor() {
        recognitionInstance = this;
      }
    }

    restoreGlobal('webkitSpeechRecognition', MockSpeechRecognition);

    expect(isWebSpeechAvailable()).toBe(true);

    const recognizer = createWebSpeechRecognizer({
      lang: 'he-IL',
      interimResults: true,
      continuous: true,
    });
    const seenEvents: Array<{ type: string; text?: string; error?: string }> = [];
    recognizer.onEvent((event) => {
      seenEvents.push(event);
    });

    recognizer.start();
    recognizer.stop();
    recognizer.abort();

    recognitionInstance?.onresult?.({
      resultIndex: 0,
      results: [
        Object.assign([{ transcript: 'shalom' }], { isFinal: false }),
        Object.assign([{ transcript: 'shalom olam' }], { isFinal: true }),
      ],
    });
    recognitionInstance?.onresult?.({
      resultIndex: 1,
      results: [
        Object.assign([{ transcript: 'shalom' }], { isFinal: false }),
        Object.assign([{ transcript: 'shalom olam' }], { isFinal: true }),
      ],
    });
    recognitionInstance?.onerror?.({ error: 'network' });

    expect(recognitionInstance?.lang).toBe('he-IL');
    expect(recognitionInstance?.continuous).toBe(true);
    expect(recognitionInstance?.interimResults).toBe(true);
    expect(recognitionInstance?.start).toHaveBeenCalledTimes(1);
    expect(recognitionInstance?.stop).toHaveBeenCalledTimes(1);
    expect(recognitionInstance?.abort).toHaveBeenCalledTimes(1);
    expect(seenEvents).toEqual([
      { type: 'partial', text: 'shalom' },
      { type: 'final', text: 'shalom olam' },
      { type: 'error', error: 'network' },
    ]);
  });

  it('wraps browser speech synthesis for client-side TTS playback', () => {
    const cancel = vi.fn();
    let spokenUtterance:
      | {
          lang?: string;
          voice?: { name?: string };
          onstart?: () => void;
          onend?: () => void;
        }
      | undefined;

    class MockSpeechSynthesisUtterance {
      lang?: string;
      rate?: number;
      pitch?: number;
      volume?: number;
      voice?: { name?: string };
      onstart?: () => void;
      onend?: () => void;
      onerror?: (event: { error?: string }) => void;

      constructor(public readonly text: string) {}
    }

    restoreGlobal('SpeechSynthesisUtterance', MockSpeechSynthesisUtterance);
    restoreGlobal('speechSynthesis', {
      speak(utterance: MockSpeechSynthesisUtterance) {
        spokenUtterance = utterance;
        utterance.onstart?.();
        utterance.onend?.();
      },
      cancel,
      getVoices() {
        return [{ name: 'Demo Voice' }];
      },
    });

    const synthesizer = createBrowserSpeechSynthesizer();
    const seenEvents: Array<{ type: string; text?: string }> = [];
    synthesizer.onEvent((event) => {
      seenEvents.push(event);
    });

    synthesizer.speak('Hello browser voice', {
      lang: 'en-US',
      voiceName: 'Demo Voice',
      rate: 1.1,
    });
    synthesizer.cancel();

    expect(spokenUtterance?.lang).toBe('en-US');
    expect(spokenUtterance?.voice?.name).toBe('Demo Voice');
    expect(seenEvents).toEqual([
      { type: 'start', text: 'Hello browser voice' },
      { type: 'end', text: 'Hello browser voice' },
      { type: 'cancel' },
    ]);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

function restoreGlobal(name: string, value: unknown): void {
  if (value === undefined) {
    Reflect.deleteProperty(globalThis, name);
    return;
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value,
  });
}
