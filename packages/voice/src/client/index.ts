export interface WebSpeechRecognizerEvent {
  type: 'partial' | 'final' | 'error';
  text?: string;
  error?: string;
}

export interface WebSpeechRecognizerOptions {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  maxAlternatives?: number;
}

export interface WebSpeechRecognizer {
  start(): void;
  stop(): void;
  abort(): void;
  onEvent(handler: (event: WebSpeechRecognizerEvent) => void): () => void;
}

export interface BrowserSpeechSynthesizerEvent {
  type: 'start' | 'end' | 'error' | 'cancel';
  text?: string;
  error?: string;
}

export interface BrowserSpeechSynthesizerOptions {
  lang?: string;
  voiceName?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
}

export interface BrowserSpeechSynthesizer {
  speak(text: string, options?: BrowserSpeechSynthesizerOptions): void;
  cancel(): void;
  onEvent(handler: (event: BrowserSpeechSynthesizerEvent) => void): () => void;
}

interface SpeechRecognitionResultLike {
  transcript?: string;
}

interface SpeechRecognitionAlternativeListLike {
  0?: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  resultIndex?: number;
  results?: ArrayLike<SpeechRecognitionAlternativeListLike & { isFinal?: boolean }>;
}

interface SpeechRecognitionLike {
  continuous?: boolean;
  interimResults?: boolean;
  lang?: string;
  maxAlternatives?: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult?: (event: SpeechRecognitionEventLike) => void;
  onerror?: (event: { error?: string }) => void;
}

interface SpeechRecognitionConstructorLike {
  new (): SpeechRecognitionLike;
}

interface SpeechSynthesisVoiceLike {
  name?: string;
}

interface SpeechSynthesisUtteranceLike {
  lang?: string;
  rate?: number;
  pitch?: number;
  volume?: number;
  voice?: SpeechSynthesisVoiceLike;
  onstart?: () => void;
  onend?: () => void;
  onerror?: (event: { error?: string }) => void;
}

interface SpeechSynthesisUtteranceConstructorLike {
  new (text: string): SpeechSynthesisUtteranceLike;
}

interface SpeechSynthesisLike {
  speak(utterance: SpeechSynthesisUtteranceLike): void;
  cancel(): void;
  getVoices?(): SpeechSynthesisVoiceLike[];
}

function getBrowserSpeechScope(): typeof globalThis & {
  SpeechRecognition?: SpeechRecognitionConstructorLike;
  webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: SpeechSynthesisUtteranceConstructorLike;
} {
  return globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructorLike;
    webkitSpeechRecognition?: SpeechRecognitionConstructorLike;
    speechSynthesis?: SpeechSynthesisLike;
    SpeechSynthesisUtterance?: SpeechSynthesisUtteranceConstructorLike;
  };
}

export function isWebSpeechAvailable(): boolean {
  const scope = getBrowserSpeechScope();
  return (
    typeof scope.SpeechRecognition === 'function' ||
    typeof scope.webkitSpeechRecognition === 'function'
  );
}

export function createWebSpeechRecognizer(
  options: WebSpeechRecognizerOptions = {},
): WebSpeechRecognizer {
  const scope = getBrowserSpeechScope();
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Recognition) {
    throw new Error('Web Speech API is not available in this browser/runtime.');
  }

  const handlers = new Set<(event: WebSpeechRecognizerEvent) => void>();
  const recognition = new Recognition();
  recognition.lang = options.lang;
  recognition.continuous = options.continuous ?? false;
  recognition.interimResults = options.interimResults ?? true;
  recognition.maxAlternatives = options.maxAlternatives ?? 1;

  recognition.onresult = (event) => {
    const resultIndex = event.resultIndex ?? 0;
    const result = event.results?.[resultIndex];
    const text = result?.[0]?.transcript?.trim();
    if (!text) {
      return;
    }

    const payload: WebSpeechRecognizerEvent = {
      type: result?.isFinal ? 'final' : 'partial',
      text,
    };
    for (const handler of handlers) {
      handler(payload);
    }
  };

  recognition.onerror = (event) => {
    const payload: WebSpeechRecognizerEvent = {
      type: 'error',
      error: event.error ?? 'unknown',
    };
    for (const handler of handlers) {
      handler(payload);
    }
  };

  return {
    start() {
      recognition.start();
    },
    stop() {
      recognition.stop();
    },
    abort() {
      recognition.abort();
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}

export function createBrowserSpeechSynthesizer(): BrowserSpeechSynthesizer {
  const scope = getBrowserSpeechScope();
  if (!scope.speechSynthesis || !scope.SpeechSynthesisUtterance) {
    throw new Error('SpeechSynthesis is not available in this browser/runtime.');
  }

  const speechSynthesis = scope.speechSynthesis;
  const SpeechSynthesisUtterance = scope.SpeechSynthesisUtterance;
  const handlers = new Set<(event: BrowserSpeechSynthesizerEvent) => void>();

  return {
    speak(text, options = {}) {
      const utterance = new SpeechSynthesisUtterance(text);
      if (options.lang !== undefined) utterance.lang = options.lang;
      if (options.rate !== undefined) utterance.rate = options.rate;
      if (options.pitch !== undefined) utterance.pitch = options.pitch;
      if (options.volume !== undefined) utterance.volume = options.volume;

      if (options.voiceName) {
        const voices = speechSynthesis.getVoices?.() ?? [];
        const selected = voices.find((voice) => voice.name === options.voiceName);
        if (selected) utterance.voice = selected;
      }

      utterance.onstart = () => {
        for (const handler of handlers) {
          handler({ type: 'start', text });
        }
      };
      utterance.onend = () => {
        for (const handler of handlers) {
          handler({ type: 'end', text });
        }
      };
      utterance.onerror = (event) => {
        for (const handler of handlers) {
          handler({ type: 'error', text, error: event.error ?? 'unknown' });
        }
      };

      speechSynthesis.speak(utterance);
    },
    cancel() {
      speechSynthesis.cancel();
      for (const handler of handlers) {
        handler({ type: 'cancel' });
      }
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
