import type { STTProviderCatalogEntry } from '../../types/provider.js';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { VoiceSttConfig } from '../../types/voice.js';
import { SONIOX_STT_MODELS } from '../../catalog/static-models.js';
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
  readOption,
  resolveRuntimeWebSocketFactory,
  resolveWebSocketUrl,
  roundMetric,
  toVendorAudioFormat,
  type RuntimeWebSocket,
  type RuntimeWebSocketFactory,
} from './shared.js';

const SONIOX_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'soniox',
  kind: 'stt',
  displayName: 'Soniox',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  knownModels: [...SONIOX_STT_MODELS],
};

class SonioxSTTProvider implements STTProvider {
  readonly capabilities = SONIOX_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #baseUrl: string | undefined;
  readonly #createWebSocket: RuntimeWebSocketFactory;
  readonly #model: string;
  readonly #enableEndpointDetection: boolean;
  readonly #languageHintsStrict: boolean;
  #audioInputSeconds = 0;
  #connectArgs: STTProviderConnectArgs | undefined;
  #finalText = '';
  #nonFinalText = '';
  #openPromise: Promise<void> | undefined;
  #pendingFinalize: Deferred<STTProviderTranscriptEvent | undefined> | undefined;
  #sessionId: string | undefined;
  #socket: RuntimeWebSocket | undefined;
  #endpointNotified = false;

  constructor(
    credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceSttConfig,
  ) {
    if (!credentials.apiKey) {
      throw new Error('Soniox STT provider requires an apiKey');
    }
    this.#apiKey = credentials.apiKey;
    this.#baseUrl = credentials.baseUrl;
    this.#createWebSocket = resolveRuntimeWebSocketFactory(credentials, voiceSlice);
    this.#model =
      voiceSlice.model ??
      readOption<string>(voiceSlice.options, 'model') ??
      'stt-rt-preview';
    this.#enableEndpointDetection =
      readOption<boolean>(voiceSlice.options, 'enableEndpointDetection') ?? true;
    this.#languageHintsStrict =
      readOption<boolean>(voiceSlice.options, 'languageHintsStrict') ?? false;
  }

  connect(args: STTProviderConnectArgs): void {
    this.#sessionId = args.sessionId;
    this.#connectArgs = args;
    this.#endpointNotified = false;
  }

  async sendAudio(audio: STTProviderAudioChunk): Promise<void> {
    await this.#ensureSocket(audio.contentType);
    this.#audioInputSeconds += estimateAudioSeconds(audio);
    this.#socket?.send(audio.chunk);
  }

  onClientTranscript(_event: STTProviderTranscriptEvent): void {}

  async finalize(): Promise<STTProviderTranscriptEvent | undefined> {
    await this.#ensureSocket();
    if (!this.#socket) {
      return undefined;
    }

    if (this.#currentText().length > 0 && !this.#pendingFinalize) {
      return this.#buildFinalEvent();
    }

    const pending = new Deferred<STTProviderTranscriptEvent | undefined>();
    this.#pendingFinalize = pending;
    this.#socket.send(JSON.stringify({ type: 'finalize' }));
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
        model: this.voiceSlice.model ?? 'soniox-stt',
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
      throw new Error('Soniox STT provider must be connected before streaming audio');
    }

    const url = resolveWebSocketUrl(
      this.#baseUrl,
      'wss://stt-rt.soniox.com',
      '/transcribe-websocket',
    );
    const socket = this.#createWebSocket(url);
    this.#socket = socket;
    this.#openPromise = new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        try {
          const contextTerms = readOption<string[]>(this.voiceSlice.options, 'contextTerms');
          const config: Record<string, unknown> = {
            api_key: this.#apiKey,
            audio_format: toVendorAudioFormat(contentType),
            language_hints: this.voiceSlice.languages,
            language_hints_strict: this.#languageHintsStrict,
            model: this.#model,
            enable_endpoint_detection: this.#enableEndpointDetection,
          };
          if (Array.isArray(contextTerms) && contextTerms.length > 0) {
            config.context = { terms: contextTerms };
          }
          socket.send(JSON.stringify(config));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
    });
    socket.on('message', (data) => {
      const message = parseSonioxMessage(data);
      if (!message) {
        return;
      }
      if (message.error_code) {
        const error = new Error(message.error_message ?? message.error_code);
        this.#pendingFinalize?.reject(error);
        return;
      }
      if (isEndpointMessage(message)) {
        void this.#notifyEndpoint();
      }
      this.#ingestTokens(message.tokens);
      if (message.finished) {
        this.#pendingFinalize?.resolve(this.#buildFinalEvent());
        this.#pendingFinalize = undefined;
      }
      if (isEndpointMessage(message)) {
        void this.#notifyEndpoint();
      }
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

  #ingestTokens(tokens: unknown): void {
    if (!Array.isArray(tokens)) {
      return;
    }

    const finalized: string[] = [];
    const pending: string[] = [];
    let endpointDetected = false;
    for (const token of tokens) {
      if (!token || typeof token !== 'object') continue;
      const text = typeof (token as { text?: unknown }).text === 'string' ? (token as { text: string }).text : '';
      if (!text) continue;
      if ((token as { is_final?: unknown }).is_final === true) {
        finalized.push(text);
      } else {
        pending.push(text);
      }
      if ((token as { is_endpoint?: unknown }).is_endpoint === true) {
        endpointDetected = true;
      }
    }

    let finalChanged = false;
    if (finalized.length > 0) {
      this.#finalText += finalized.join('');
      finalChanged = true;
    }
    this.#nonFinalText = pending.join('');
    const current = this.#currentText();
    if (current.length > 0) {
      void this.#connectArgs?.onTranscript?.({
        text: current,
        final: false,
      });
    }

    if (finalChanged) {
      const finalEvent = this.#buildFinalEvent();
      if (finalEvent) {
        void this.#connectArgs?.onTranscript?.(finalEvent);
      }
    }

    if (endpointDetected) {
      void this.#notifyEndpoint();
    }

    if (this.#pendingFinalize && this.#nonFinalText.length === 0) {
      this.#pendingFinalize.resolve(this.#buildFinalEvent());
      this.#pendingFinalize = undefined;
    }
  }

  async #notifyEndpoint(): Promise<void> {
    if (this.#endpointNotified) return;
    this.#endpointNotified = true;
    await this.#connectArgs?.onEndpoint?.();
  }

  #buildFinalEvent(): STTProviderTranscriptEvent | undefined {
    if (this.#finalText.length === 0) {
      return undefined;
    }
    return {
      text: this.#finalText,
      final: true,
    };
  }

  #currentText(): string {
    return `${this.#finalText}${this.#nonFinalText}`;
  }
}

export const SONIOX_STT_REGISTRATION: STTProviderRegistration = {
  descriptor: SONIOX_STT_DESCRIPTOR,
  create(credentials, voiceSlice) {
    return new SonioxSTTProvider(credentials, voiceSlice);
  },
};

function parseSonioxMessage(
  payload: Buffer | ArrayBuffer | Buffer[],
): {
  error_code?: string;
  error_message?: string;
  tokens?: unknown;
  finished?: boolean;
  endpoint?: boolean;
  speech_end?: boolean;
} | undefined {
  const text = payloadToText(payload);
  if (!text) {
    return undefined;
  }
  return JSON.parse(text) as {
    error_code?: string;
    error_message?: string;
    tokens?: unknown;
    finished?: boolean;
    endpoint?: boolean;
    speech_end?: boolean;
  };
}

function isEndpointMessage(message: {
  endpoint?: boolean;
  speech_end?: boolean;
}): boolean {
  return message.endpoint === true || message.speech_end === true;
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
