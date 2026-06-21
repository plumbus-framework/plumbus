import { ErrorCode, PlumbusError } from '@plumbus/core';
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
  parseAudioFormat,
  readOption,
  roundMetric,
} from './shared.js';

/** Soniox in-stream control token marking end-of-speech. */
const SONIOX_ENDPOINT_MARKER = '<end>';
/** Soniox in-stream control token marking finalization completion. */
const SONIOX_FINALIZED_MARKER = '<fin>';

const SONIOX_STT_DESCRIPTOR: STTProviderCatalogEntry = {
  id: 'soniox',
  kind: 'stt',
  displayName: 'Soniox',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  languages: 'multilingual',
  endpointDetection: true,
  knownModels: [...SONIOX_STT_MODELS],
};

/**
 * Minimal structural surface of the official `@soniox/node` real-time STT session
 * we use. We go through the SDK (not a hand-rolled WebSocket) so token spacing,
 * `<end>`/`<fin>` control-marker handling, endpoint detection, keepalive, and
 * reconnection match Soniox's reference behavior.
 */
interface SonioxRealtimeToken {
  text?: string;
  is_final?: boolean;
  confidence?: number;
  language?: string;
}

interface SonioxRealtimeResult {
  tokens?: SonioxRealtimeToken[];
  finished?: boolean;
}

interface SonioxSttSession {
  connect(): Promise<void>;
  sendAudio(data: Uint8Array): void;
  finalize(options?: { trailing_silence_ms?: number }): void;
  finish(): Promise<void>;
  close(): void;
  on(event: string, handler: (...args: any[]) => void): unknown;
}

interface SonioxRealtimeApiLike {
  stt(config: Record<string, unknown>, options?: Record<string, unknown>): SonioxSttSession;
}

interface SonioxClientLike {
  realtime: SonioxRealtimeApiLike;
}

type SonioxClientFactory = (apiKey: string) => SonioxClientLike;

class SonioxSTTProvider implements STTProvider {
  readonly capabilities = SONIOX_STT_DESCRIPTOR;
  readonly #apiKey: string;
  readonly #model: string;
  readonly #enableEndpointDetection: boolean;
  #audioInputSeconds = 0;
  #connectArgs: STTProviderConnectArgs | undefined;
  #sessionId: string | undefined;
  #session: SonioxSttSession | undefined;
  #sessionPromise: Promise<SonioxSttSession> | undefined;
  #finalText = '';
  #nonFinalText = '';
  #latestConfidence: number | undefined;
  #latestLanguage: string | undefined;
  #firstTranscriptLogged = false;
  #endpointInFlight = false;
  #pendingFinalize: Deferred<STTProviderTranscriptEvent | undefined> | undefined;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceSttConfig,
  ) {
    if (!credentials.apiKey) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Soniox STT provider requires an apiKey',
      );
    }
    this.#apiKey = credentials.apiKey;
    this.#model =
      voiceSlice.model ?? readOption<string>(voiceSlice.options, 'model') ?? 'stt-rt-v5';
    this.#enableEndpointDetection =
      readOption<boolean>(voiceSlice.options, 'enableEndpointDetection') ?? true;
  }

  connect(args: STTProviderConnectArgs): void {
    this.#sessionId = args.sessionId;
    this.#connectArgs = args;
  }

  async sendAudio(audio: STTProviderAudioChunk): Promise<void> {
    const session = await this.#ensureSession(audio.contentType);
    this.#audioInputSeconds += estimateAudioSeconds(audio);
    session.sendAudio(audio.chunk);
  }

  onClientTranscript(_event: STTProviderTranscriptEvent): void {}

  async finalize(): Promise<STTProviderTranscriptEvent | undefined> {
    const session = await this.#ensureSession();
    if (this.#currentText().trim().length > 0 && !this.#pendingFinalize) {
      const event = this.#buildFinalEvent();
      this.#resetUtterance();
      return event;
    }
    const pending = new Deferred<STTProviderTranscriptEvent | undefined>();
    this.#pendingFinalize = pending;
    session.finalize();
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
        model: 'soniox-stt',
        metadata: { sessionId: this.#sessionId },
      },
    ];
  }

  disconnect(): void {
    this.#pendingFinalize?.resolve(this.#buildFinalEvent());
    this.#pendingFinalize = undefined;
    try {
      this.#session?.close();
    } catch {
      // ignore close errors on a torn-down session
    }
    this.#session = undefined;
    this.#sessionPromise = undefined;
  }

  #ensureSession(contentType?: string): Promise<SonioxSttSession> {
    if (this.#session) {
      return Promise.resolve(this.#session);
    }
    if (this.#sessionPromise) {
      return this.#sessionPromise;
    }
    if (!this.#connectArgs?.sessionId) {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Soniox STT provider must be connected before streaming audio',
      );
    }

    this.#sessionPromise = (async () => {
      const factory = await resolveSonioxClientFactory(this.credentials);
      const client = factory(this.#apiKey);
      const audio = parseAudioFormat(contentType);
      const contextTerms = readOption<string[]>(this.voiceSlice.options, 'contextTerms');
      const maxEndpointDelayMs = readOption<number>(this.voiceSlice.options, 'maxEndpointDelayMs');
      const endpointSensitivity = readOption<number>(
        this.voiceSlice.options,
        'endpointSensitivity',
      );
      const config: Record<string, unknown> = {
        model: this.#model,
        audio_format: 'pcm_s16le',
        sample_rate: audio.sampleRate,
        num_channels: audio.channels,
        language_hints: this.voiceSlice.languages,
        enable_endpoint_detection: this.#enableEndpointDetection,
      };
      if (typeof maxEndpointDelayMs === 'number') {
        config.max_endpoint_delay_ms = maxEndpointDelayMs;
      }
      if (typeof endpointSensitivity === 'number') {
        config.endpoint_sensitivity = endpointSensitivity;
      }
      if (Array.isArray(contextTerms) && contextTerms.length > 0) {
        config.context = { terms: contextTerms };
      }
      const session = client.realtime.stt(config);
      this.#wireSession(session);
      await session.connect();
      console.info('[voice-stt] soniox session connected', {
        sessionId: this.#sessionId,
        model: this.#model,
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        via: 'sdk',
      });
      this.#session = session;
      return session;
    })();

    try {
      return this.#sessionPromise;
    } catch (error) {
      this.#sessionPromise = undefined;
      throw error;
    }
  }

  #wireSession(session: SonioxSttSession): void {
    session.on('result', (result: SonioxRealtimeResult) => {
      this.#ingestResult(result);
    });
    session.on('endpoint', () => {
      void this.#handleEndpoint();
    });
    session.on('finalized', () => {
      if (this.#pendingFinalize) {
        this.#pendingFinalize.resolve(this.#buildFinalEvent());
        this.#pendingFinalize = undefined;
        this.#resetUtterance();
      }
    });
    session.on('error', (error: Error) => {
      console.error('[voice-stt] soniox error', {
        sessionId: this.#sessionId,
        message: error?.message ?? String(error),
      });
      this.#pendingFinalize?.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pendingFinalize = undefined;
    });
  }

  #ingestResult(result: SonioxRealtimeResult): void {
    const tokens = Array.isArray(result.tokens) ? result.tokens : [];
    if (process.env.VOICE_STT_DEBUG_TOKENS === 'true') {
      console.info('[voice-stt] soniox raw tokens', {
        sessionId: this.#sessionId,
        tokens: tokens.map((t) => ({ text: t.text, is_final: t.is_final })),
      });
    }
    const finalized: string[] = [];
    const pending: string[] = [];
    let minConfidence: number | undefined;
    let detectedLanguage: string | undefined;
    // Soniox marks end-of-speech / finalization with in-stream control tokens
    // (`<end>` / `<fin>`). We treat the `<end>` token as the authoritative
    // endpoint signal (in addition to the SDK's derived `endpoint` event) so a
    // turn fires the moment Soniox detects the boundary — never relying on the
    // controller's silence-timer failsafe when Soniox has spoken.
    let sawEndpointMarker = false;
    for (const token of tokens) {
      const text = typeof token.text === 'string' ? token.text : '';
      if (!text) continue;
      if (text === SONIOX_ENDPOINT_MARKER) {
        sawEndpointMarker = true;
        continue;
      }
      if (text === SONIOX_FINALIZED_MARKER) {
        continue;
      }
      if (typeof token.confidence === 'number') {
        minConfidence =
          minConfidence === undefined
            ? token.confidence
            : Math.min(minConfidence, token.confidence);
      }
      if (typeof token.language === 'string') {
        detectedLanguage = token.language;
      }
      if (token.is_final === true) {
        finalized.push(text);
      } else {
        pending.push(text);
      }
    }

    if (minConfidence !== undefined) {
      this.#latestConfidence = minConfidence;
    }
    if (detectedLanguage) {
      this.#latestLanguage = detectedLanguage;
    }
    const hadTextBefore = this.#currentText().trim().length > 0;
    if (finalized.length > 0 || pending.length > 0) {
      // New speech after a prior endpoint starts a fresh utterance, so allow the
      // next endpoint to fire.
      if (!hadTextBefore) {
        this.#endpointInFlight = false;
      }
    }
    if (finalized.length > 0) {
      this.#finalText += finalized.join('');
    }
    this.#nonFinalText = pending.join('');

    const current = this.#currentText();
    if (current.trim().length > 0) {
      if (!this.#firstTranscriptLogged) {
        this.#firstTranscriptLogged = true;
        console.info('[voice-stt] first soniox transcript received', {
          sessionId: this.#sessionId,
          via: 'sdk',
        });
      }
      void this.#connectArgs?.onTranscript?.({
        text: current,
        final: false,
        confidence: this.#latestConfidence,
        language: this.#latestLanguage,
      });
    }

    if (sawEndpointMarker) {
      void this.#handleEndpoint();
    }
  }

  async #handleEndpoint(): Promise<void> {
    // The endpoint can be observed twice for one utterance — once from the `<end>`
    // control token in the result stream and once from the SDK's derived
    // `endpoint` event. Fire the downstream turn only once per utterance.
    if (this.#endpointInFlight) {
      return;
    }
    this.#endpointInFlight = true;
    const event = this.#buildFinalEvent();
    if (event) {
      void this.#connectArgs?.onTranscript?.(event);
    }
    if (this.#pendingFinalize) {
      this.#pendingFinalize.resolve(event);
      this.#pendingFinalize = undefined;
    }
    console.info('[voice-stt] soniox endpoint', {
      sessionId: this.#sessionId,
      transcriptChars: this.#currentText().trim().length,
    });
    // Reset per-utterance state synchronously (before awaiting the consumer) so the
    // next utterance's tokens start clean even if results arrive immediately.
    this.#resetUtterance();
    await this.#connectArgs?.onEndpoint?.();
  }

  #buildFinalEvent(): STTProviderTranscriptEvent | undefined {
    const text = this.#currentText().trim();
    if (text.length === 0) {
      return undefined;
    }
    return {
      text,
      final: true,
      confidence: this.#latestConfidence,
      language: this.#latestLanguage,
    };
  }

  #currentText(): string {
    return `${this.#finalText}${this.#nonFinalText}`;
  }

  #resetUtterance(): void {
    this.#finalText = '';
    this.#nonFinalText = '';
    this.#latestConfidence = undefined;
    this.#latestLanguage = undefined;
  }
}

export const SONIOX_STT_REGISTRATION: STTProviderRegistration = {
  descriptor: SONIOX_STT_DESCRIPTOR,
  create(credentials, voiceSlice) {
    return new SonioxSTTProvider(credentials, voiceSlice);
  },
};

async function resolveSonioxClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<SonioxClientFactory> {
  const injected = (credentials.options as Record<string, unknown> | undefined)
    ?.sonioxClientFactory;
  if (typeof injected === 'function') {
    return injected as SonioxClientFactory;
  }
  const imported = (await import('@soniox/node')) as {
    SonioxNodeClient?: new (options: { api_key: string }) => SonioxClientLike;
    default?: { SonioxNodeClient?: new (options: { api_key: string }) => SonioxClientLike };
  };
  const ClientCtor = imported.SonioxNodeClient ?? imported.default?.SonioxNodeClient;
  if (typeof ClientCtor !== 'function') {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Unable to load SonioxNodeClient from @soniox/node',
    );
  }
  return (apiKey) => new ClientCtor({ api_key: apiKey });
}
