import type { STTProviderCatalogEntry } from '../../types/provider.js';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { VoiceSttConfig } from '../../types/voice.js';
import { OPENAI_REALTIME_STT_MODELS } from '../../catalog/static-models.js';
import type { STTProviderRegistration } from '../base/provider-registration.js';
import type {
  STTProvider,
  STTProviderAudioChunk,
  STTProviderConnectArgs,
  STTProviderTranscriptEvent,
} from '../base/stt-provider.js';
import {
  Deferred,
  estimateAudioSeconds,
  parseAudioFormat,
  readOption,
  resolveRuntimeWebSocketFactory,
  resolveWebSocketUrl,
  roundMetric,
  toBase64,
  type RuntimeWebSocket,
  type RuntimeWebSocketFactory,
} from './shared.js';

const OPENAI_REALTIME_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'openai-realtime',
  kind: 'stt',
  displayName: 'OpenAI Realtime',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  knownModels: [...OPENAI_REALTIME_STT_MODELS],
};

class OpenAIRealtimeSTTProvider implements STTProvider {
  readonly capabilities = OPENAI_REALTIME_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #baseUrl: string | undefined;
  readonly #createWebSocket: RuntimeWebSocketFactory;
  readonly #delay: string | undefined;
  readonly #language: string | undefined;
  readonly #model: string;
  #audioInputSeconds = 0;
  #connectArgs: STTProviderConnectArgs | undefined;
  #currentPartial = '';
  #finalText = '';
  #lastItemId: string | undefined;
  #openPromise: Promise<void> | undefined;
  #pendingFinalize: Deferred<STTProviderTranscriptEvent | undefined> | undefined;
  #sessionId: string | undefined;
  #socket: RuntimeWebSocket | undefined;

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
    this.#baseUrl = credentials.baseUrl;
    this.#createWebSocket = resolveRuntimeWebSocketFactory(credentials, voiceSlice);
    this.#delay = readOption<string>(voiceSlice.options, 'delay');
    this.#language = voiceSlice.languages?.[0];
    this.#model = voiceSlice.model ?? OPENAI_REALTIME_STT_MODELS[0]?.id ?? 'gpt-realtime-whisper';
  }

  connect(args: STTProviderConnectArgs): void {
    this.#sessionId = args.sessionId;
    this.#connectArgs = args;
  }

  async sendAudio(audio: STTProviderAudioChunk): Promise<void> {
    await this.#ensureSocket(audio.contentType);
    this.#audioInputSeconds += estimateAudioSeconds(audio);
    this.#socket?.send(
      JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: toBase64(audio.chunk),
      }),
    );
  }

  onClientTranscript(_event: STTProviderTranscriptEvent): void {}

  async finalize(): Promise<STTProviderTranscriptEvent | undefined> {
    await this.#ensureSocket();
    if (!this.#socket) {
      return undefined;
    }
    const pending = new Deferred<STTProviderTranscriptEvent | undefined>();
    this.#pendingFinalize = pending;
    this.#socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
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
    this.#socket?.close();
    this.#socket = undefined;
    this.#openPromise = undefined;
  }

  #ensureSocket(contentType?: string): Promise<void> {
    if (this.#openPromise) {
      return this.#openPromise;
    }
    if (!this.#connectArgs?.sessionId) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'OpenAI Realtime STT provider must be connected before streaming audio',
      );
    }

    const url = resolveWebSocketUrl(
      this.#baseUrl,
      'wss://api.openai.com',
      '/v1/realtime',
      new URLSearchParams({ intent: 'transcription' }),
    );
    const socket = this.#createWebSocket(url, {
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
      },
    });
    this.#socket = socket;
    this.#openPromise = new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        try {
          const format = parseAudioFormat(contentType);
          socket.send(
            JSON.stringify({
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
                      model: this.#model,
                      ...(this.#delay ? { delay: this.#delay } : {}),
                      ...(this.#language ? { language: this.#language } : {}),
                    },
                    turn_detection: null,
                  },
                },
              },
            }),
          );
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    });
    socket.on('message', (data) => {
      const message = parseMessage(data);
      if (!message) {
        return;
      }
      this.#handleMessage(message);
    });
    socket.on('error', (error) => {
      this.#pendingFinalize?.reject(error);
    });
    socket.on('close', () => {
      if (this.#pendingFinalize) {
        this.#pendingFinalize.resolve(this.#buildFinalEvent());
        this.#pendingFinalize = undefined;
      }
      this.#socket = undefined;
      this.#openPromise = undefined;
    });
    return this.#openPromise;
  }

  #handleMessage(message: Record<string, unknown>): void {
    if (message.type === 'error') {
      this.#pendingFinalize?.reject(
        new Error(typeof message.message === 'string' ? message.message : 'OpenAI realtime error'),
      );
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
  create(credentials, voiceSlice) {
    return new OpenAIRealtimeSTTProvider(credentials, voiceSlice);
  },
};

function parseMessage(
  payload: Buffer | ArrayBuffer | Buffer[],
): Record<string, unknown> | undefined {
  const text = payloadToText(payload);
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function payloadToText(payload: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(payload)) {
    return Buffer.concat(payload).toString('utf-8');
  }
  if (payload instanceof ArrayBuffer) {
    return Buffer.from(payload).toString('utf-8');
  }
  return payload.toString('utf-8');
}
