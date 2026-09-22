import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  Deferred,
  estimateAudioSeconds,
  parseAudioFormat,
  readOption,
  roundMetric,
  type STTProvider,
  type STTProviderAudioChunk,
  type STTProviderConnectArgs,
  type STTProviderRegistration,
  type STTProviderTranscriptEvent,
  toBase64,
  type VoiceProviderCredentials,
  type VoiceSttConfig,
} from '@plumbus/voice/provider-kit';
import OpenAI from 'openai';
import { OPENAI_REALTIME_STT_DESCRIPTOR, OPENAI_REALTIME_STT_MODELS } from './descriptor.js';
import { resolveOpenAIBaseURL } from './openai-client.js';
import { OPENAI_VOICE_PRICING } from './pricing.js';

/** Default Realtime WebSocket connection model (URL `?model=`). Transcription model is separate. */
export const OPENAI_REALTIME_CONNECTION_MODEL = 'gpt-realtime';

/**
 * Minimal surface of `OpenAIRealtimeWS` / `OpenAIRealtimeWebSocket` used for STT.
 * Inject `credentials.options.openaiRealtimeFactory` in tests.
 */
export interface OpenAIRealtimeSessionLike {
  send(event: Record<string, unknown>): void;
  close(props?: { code?: number; reason?: string }): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  socket?: {
    readyState?: number;
    once(event: string, listener: (...args: any[]) => void): unknown;
    off?(event: string, listener: (...args: any[]) => void): unknown;
  };
}

export type OpenAIRealtimeFactory = (args: {
  apiKey: string;
  /** HTTP(S) OpenAI-compatible base; SDK converts to `wss` for Realtime. */
  baseURL?: string;
  /** Connection model for the Realtime WebSocket URL. */
  model: string;
}) => OpenAIRealtimeSessionLike | Promise<OpenAIRealtimeSessionLike>;

class OpenAIRealtimeSTTProvider implements STTProvider {
  readonly capabilities = OPENAI_REALTIME_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #baseURL: string | undefined;
  readonly #connectionModel: string;
  readonly #delay: string | undefined;
  readonly #language: string | undefined;
  readonly #realtimeFactory: OpenAIRealtimeFactory;
  readonly #transcriptionModel: string;
  #audioInputSeconds = 0;
  #connectArgs: STTProviderConnectArgs | undefined;
  #currentPartial = '';
  #finalText = '';
  #lastItemId: string | undefined;
  #openPromise: Promise<void> | undefined;
  #pendingFinalize: Deferred<STTProviderTranscriptEvent | undefined> | undefined;
  #session: OpenAIRealtimeSessionLike | undefined;
  #sessionId: string | undefined;

  constructor(
    credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceSttConfig,
  ) {
    if (!credentials.apiKey) {
      throw new PlumbusError(
        ErrorCode.Validation,
        'OpenAI Realtime STT provider requires an apiKey',
      );
    }
    this.#apiKey = credentials.apiKey;
    this.#baseURL = resolveOpenAIRealtimeBaseURL(credentials);
    this.#realtimeFactory = resolveOpenAIRealtimeFactory(credentials);
    this.#delay = readOption<string>(voiceSlice.options, 'delay');
    this.#language = voiceSlice.languages?.[0];
    this.#transcriptionModel =
      voiceSlice.model ?? OPENAI_REALTIME_STT_MODELS[0]?.id ?? 'gpt-realtime-whisper';
    this.#connectionModel =
      readOption<string>(voiceSlice.options, 'realtimeConnectionModel') ??
      OPENAI_REALTIME_CONNECTION_MODEL;
  }

  connect(args: STTProviderConnectArgs): void {
    this.#sessionId = args.sessionId;
    this.#connectArgs = args;
  }

  async sendAudio(audio: STTProviderAudioChunk): Promise<void> {
    await this.#ensureSession(audio.contentType);
    this.#audioInputSeconds += estimateAudioSeconds(audio);
    this.#session?.send({
      type: 'input_audio_buffer.append',
      audio: toBase64(audio.chunk),
    });
  }

  onClientTranscript(_event: STTProviderTranscriptEvent): void {}

  async finalize(): Promise<STTProviderTranscriptEvent | undefined> {
    await this.#ensureSession();
    if (!this.#session) {
      return undefined;
    }
    const pending = new Deferred<STTProviderTranscriptEvent | undefined>();
    this.#pendingFinalize = pending;
    this.#session.send({ type: 'input_audio_buffer.commit' });
    return pending.promise;
  }

  usage() {
    if (this.#audioInputSeconds <= 0) {
      return [];
    }

    return [
      {
        provider: this.capabilities.id,
        kind: 'transcribe' as const,
        quantity: roundMetric(this.#audioInputSeconds),
        unit: 'seconds' as const,
        model: this.voiceSlice.model ?? OPENAI_REALTIME_STT_MODELS[0]?.id ?? 'gpt-realtime-whisper',
        metadata: { sessionId: this.#sessionId },
      },
    ];
  }

  disconnect(): void {
    this.#pendingFinalize?.resolve(this.#buildFinalEvent());
    this.#pendingFinalize = undefined;
    this.#session?.close({ code: 1000, reason: 'OK' });
    this.#session = undefined;
    this.#openPromise = undefined;
  }

  #ensureSession(contentType?: string): Promise<void> {
    if (this.#openPromise) {
      return this.#openPromise;
    }
    if (!this.#connectArgs?.sessionId) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'OpenAI Realtime STT provider must be connected before streaming audio',
      );
    }

    this.#openPromise = this.#openSession(contentType);
    return this.#openPromise;
  }

  async #openSession(contentType?: string): Promise<void> {
    const session = await this.#realtimeFactory({
      apiKey: this.#apiKey,
      baseURL: this.#baseURL,
      model: this.#connectionModel,
    });
    this.#session = session;

    session.on('error', (error: unknown) => {
      const message = error instanceof Error ? error.message : 'OpenAI realtime error';
      this.#pendingFinalize?.reject(new Error(message));
    });
    session.on('conversation.item.input_audio_transcription.delta', (event: unknown) => {
      this.#handleMessage(asRecord(event));
    });
    session.on('conversation.item.input_audio_transcription.completed', (event: unknown) => {
      this.#handleMessage(asRecord(event));
    });
    session.on('event', (event: unknown) => {
      const message = asRecord(event);
      if (message.type === 'error') {
        this.#handleMessage(message);
      }
    });

    await waitUntilRealtimeOpen(session);

    const format = parseAudioFormat(contentType);
    session.send({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: {
              type: 'audio/pcm',
              rate: format.sampleRate,
            },
            transcription: {
              model: this.#transcriptionModel,
              ...(this.#delay ? { delay: this.#delay } : {}),
              ...(this.#language ? { language: this.#language } : {}),
            },
            turn_detection: null,
          },
        },
      },
    });
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (message.type === 'error') {
      const nested = asRecord(message.error);
      const detail =
        typeof nested.message === 'string'
          ? nested.message
          : typeof message.message === 'string'
            ? message.message
            : 'OpenAI realtime error';
      this.#pendingFinalize?.reject(new Error(detail));
      return;
    }

    if (message.type === 'conversation.item.input_audio_transcription.delta') {
      const itemId = typeof message.item_id === 'string' ? message.item_id : undefined;
      if (itemId && itemId !== this.#lastItemId) {
        this.#currentPartial = '';
        this.#lastItemId = itemId;
      }
      const delta = typeof message.delta === 'string' ? message.delta : '';
      this.#currentPartial += delta;
      const text = `${this.#finalText}${this.#currentPartial}`;
      if (text) {
        void this.#connectArgs?.onTranscript?.({
          text,
          final: false,
          language: this.#language,
        });
      }
      return;
    }

    if (message.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = typeof message.transcript === 'string' ? message.transcript.trim() : '';
      if (!transcript) {
        this.#pendingFinalize?.resolve(undefined);
        this.#pendingFinalize = undefined;
        return;
      }
      this.#finalText = transcript;
      this.#currentPartial = '';
      const finalEvent = this.#buildFinalEvent();
      if (finalEvent) {
        void this.#connectArgs?.onTranscript?.(finalEvent);
      }
      this.#pendingFinalize?.resolve(finalEvent);
      this.#pendingFinalize = undefined;
    }
  }

  #buildFinalEvent(): STTProviderTranscriptEvent | undefined {
    if (!this.#finalText) {
      return undefined;
    }
    return {
      text: this.#finalText,
      final: true,
      language: this.#language,
    };
  }
}

export const OPENAI_REALTIME_STT_REGISTRATION: STTProviderRegistration = {
  descriptor: OPENAI_REALTIME_STT_DESCRIPTOR,
  pricing: Object.values(OPENAI_VOICE_PRICING).filter(
    (entry) => entry.model === 'gpt-realtime-whisper',
  ),
  create(credentials, voiceSlice) {
    return new OpenAIRealtimeSTTProvider(credentials, voiceSlice);
  },
};

/** Convert credential `baseUrl` to an HTTP(S) base the Realtime SDK can upgrade to `wss`. */
export function resolveOpenAIRealtimeBaseURL(
  credentials: VoiceProviderCredentials,
): string | undefined {
  const base = resolveOpenAIBaseURL(credentials);
  if (!base) {
    return undefined;
  }
  return base.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:');
}

export function resolveOpenAIRealtimeFactory(
  credentials: VoiceProviderCredentials,
): OpenAIRealtimeFactory {
  const injected = (credentials.options as Record<string, unknown> | undefined)
    ?.openaiRealtimeFactory;
  if (typeof injected === 'function') {
    return injected as OpenAIRealtimeFactory;
  }
  return createDefaultOpenAIRealtimeSession;
}

export async function createDefaultOpenAIRealtimeSession(args: {
  apiKey: string;
  baseURL?: string;
  model: string;
}): Promise<OpenAIRealtimeSessionLike> {
  const { OpenAIRealtimeWS } = await import('openai/realtime/ws.js');
  const client = new OpenAI({
    apiKey: args.apiKey,
    ...(args.baseURL ? { baseURL: args.baseURL } : {}),
  });
  const session = await OpenAIRealtimeWS.create(client, { model: args.model });
  return session as unknown as OpenAIRealtimeSessionLike;
}

async function waitUntilRealtimeOpen(session: OpenAIRealtimeSessionLike): Promise<void> {
  const socket = session.socket;
  if (!socket) {
    return;
  }
  // `ws` OPEN === 1
  if (socket.readyState === 1) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const cleanup = () => {
      socket.off?.('open', onOpen);
      socket.off?.('error', onError);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
