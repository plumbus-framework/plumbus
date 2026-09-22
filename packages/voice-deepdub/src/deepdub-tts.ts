import type { TtsParams } from '@deepdub/node';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  type DeliveryTone,
  getVoiceModelOption,
  normalizeVoiceList,
  type TTSProvider,
  type TTSProviderRegistration,
  type VoiceProviderCredentials,
  type VoiceTtsConfig,
} from '@plumbus/voice/provider-kit';
import {
  type DeepdubClientFactory,
  type DeepdubSdkClient,
  resolveDeepdubClientFactory,
  resolveDeepdubRestBaseUrl,
} from './deepdub-client.js';
import {
  DEEPDUB_CLONE_CAPABILITIES,
  DeepdubVoiceCloneProvider,
  deepdubSynthesizeWithVoiceReference,
} from './deepdub-voice-clone.js';
import { DEEPDUB_TTS_DESCRIPTOR, DEEPDUB_TTS_MODELS } from './descriptor.js';
import { DEEPDUB_VOICE_PRICING } from './pricing.js';

/**
 * Deepdub keeps one long-lived websocket per provider instance, and an idle
 * conversational gap is enough for the far end to close it — the next reply
 * then fails with "WebSocket is not connected", which reads to the user as the
 * voice dying mid-session. Reconnect attempts after a drop, spaced so a
 * momentary refusal is not mistaken for a dead service.
 */
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;
/**
 * Reconnect before synthesizing when the socket has been quiet this long. The
 * far end (`wss://wsapi.deepdub.ai/open`) closes idle connections and the SDK
 * has no keepalive for this socket — it ships `asyncStreamPing` only for its
 * separate streaming endpoint, and API Gateway ignores websocket ping frames
 * anyway, so a heartbeat would have to be an application message on a route
 * this API does not document. Reconnecting on demand needs no such guess: a
 * handshake costs milliseconds next to synthesis, and only after a real pause.
 */
const IDLE_RECONNECT_MS = 120_000;

class DeepdubTTSProvider implements TTSProvider {
  readonly capabilities = DEEPDUB_TTS_DESCRIPTOR;
  // Deepdub bills by minutes of generated audio, so usage is metered in
  // output bytes and converted to seconds at the stream's sample rate.
  #audioBytes = 0;
  #client: DeepdubSdkClient | undefined;
  #connectPromise: Promise<DeepdubSdkClient> | undefined;
  #lastUsedAt = 0;
  readonly #reconnectDelayMs: number;
  readonly #idleReconnectMs: number;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {
    this.#reconnectDelayMs = resolveReconnectDelayMs(credentials);
    this.#idleReconnectMs = resolveIdleReconnectMs(credentials);
  }

  /** Drop a socket that has been idle long enough for the far end to close it. */
  #discardIfStale(): void {
    if (!this.#client || this.#lastUsedAt === 0) {
      return;
    }
    if (Date.now() - this.#lastUsedAt < this.#idleReconnectMs) {
      return;
    }
    console.info('[voice-tts] deepdub socket idle — reconnecting before synthesis', {
      idleMs: Date.now() - this.#lastUsedAt,
    });
    this.#resetClient();
  }

  /**
   * Opens the websocket, retrying a refused connection on the same schedule as
   * a dropped one. Surfaces the last error when every attempt fails.
   */
  async #connectWithRetry(signal?: AbortSignal): Promise<DeepdubSdkClient> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        await sleep(this.#reconnectDelayMs, signal);
        if (signal?.aborted) {
          break;
        }
      }
      try {
        return await this.#getClient();
      } catch (error: unknown) {
        lastError = error;
        this.#resetClient();
        console.warn('[voice-tts] deepdub connect failed', {
          attempt,
          of: RECONNECT_ATTEMPTS,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  mapDeliveryTone(tone: DeliveryTone) {
    return {
      // Per-turn style-variant switching: a tone-supplied voiceId (a
      // voicePromptId of the same speaker family) overrides the static voice.
      voiceId: tone.voiceId ?? this.voiceSlice.voiceId,
      model: this.voiceSlice.model ?? DEEPDUB_TTS_MODELS[0]?.id,
      tempo: mapPace(tone.pace),
      variance: mapWarmth(tone.warmth),
      temperature: mapEnergy(tone.energy),
      promptBoost: Boolean(tone.emotion && tone.emotion !== 'neutral'),
      locale: this.voiceSlice.locale,
      targetGender: tone.targetGender,
    };
  }

  async *synthesizeStream(text: string, params: unknown, signal?: AbortSignal) {
    const voiceReference = resolveVoiceReference(this.voiceSlice.options, params);
    if (voiceReference) {
      const buffer = await deepdubSynthesizeWithVoiceReference(this.credentials, {
        text,
        audio: voiceReference,
        locale: this.voiceSlice.locale,
        model: this.voiceSlice.model,
      });
      if (signal?.aborted) {
        return;
      }
      this.#audioBytes += buffer.byteLength;
      yield buffer;
      return;
    }

    const options = this.#buildGenerationParams(params);

    const queue: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    let failure: Error | undefined;
    let firstChunkLogged = false;

    const onAbort = () => {
      finished = true;
      wake?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const pushChunk = (chunk: Uint8Array) => {
      if (!chunk || chunk.length === 0) return;
      this.#audioBytes += chunk.byteLength;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        console.info('[voice-tts] first deepdub audio chunk received', {
          bytes: chunk.byteLength,
        });
      }
      queue.push(chunk);
      wake?.();
    };

    this.#discardIfStale();
    const client = await this.#connectWithRetry(signal);

    console.info('[voice-tts] deepdub synthesis requested', {
      characters: text.length,
      model: options.model,
      locale: options.locale,
      via: 'sdk',
    });

    const generation = this.#startGeneration(client, text, options, pushChunk)
      .then(() => {
        finished = true;
        wake?.();
      })
      .catch(async (error: unknown) => {
        const settle = (result?: Error) => {
          failure = result;
          finished = true;
          wake?.();
        };
        if (!isDeepdubDisconnectedError(error)) {
          settle(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        // Retrying re-synthesizes the whole utterance, so it is only safe
        // before any audio has been published — otherwise the listener would
        // hear the opening of the reply twice.
        if (firstChunkLogged) {
          settle(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        let lastError = error instanceof Error ? error : new Error(String(error));
        for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
          if (attempt > 1) {
            await sleep(this.#reconnectDelayMs, signal);
          }
          if (signal?.aborted) {
            settle();
            return;
          }
          console.warn('[voice-tts] deepdub websocket dropped — reconnecting', {
            attempt,
            of: RECONNECT_ATTEMPTS,
            message: lastError.message,
          });
          this.#resetClient();
          try {
            const retryClient = await this.#getClient();
            await this.#startGeneration(retryClient, text, options, pushChunk);
            settle();
            return;
          } catch (retryError: unknown) {
            lastError = retryError instanceof Error ? retryError : new Error(String(retryError));
          }
        }
        console.error('[voice-tts] deepdub reconnect gave up', {
          attempts: RECONNECT_ATTEMPTS,
          message: lastError.message,
        });
        settle(lastError);
      });

    try {
      while (true) {
        if (signal?.aborted) return;
        if (queue.length > 0) {
          const chunk = queue.shift();
          if (chunk) {
            yield chunk;
          }
          continue;
        }
        if (failure) throw failure;
        if (finished) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      if (failure) throw failure;
      console.info('[voice-tts] deepdub synthesis finished', {
        producedAudio: firstChunkLogged,
        via: 'sdk',
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
      void generation.catch(() => undefined);
    }
  }

  abortGeneration(): void {}

  abortAll(): void {}

  async flush(): Promise<void> {
    this.#resetClient();
  }

  #resetClient(): void {
    const client = this.#client;
    this.#client = undefined;
    this.#connectPromise = undefined;
    try {
      client?.disconnect?.();
    } catch {
      // ignore disconnect errors on a torn-down client
    }
  }

  /**
   * `async` is load-bearing. `generateToBuffer` → `generateTo` are plain
   * functions in @deepdub/node, and the readyState check throws
   * *synchronously*: `#startGeneration(...).catch(retry)` never attaches its
   * handler, so the throw escapes `synthesizeStream` and no reconnect runs —
   * which is why a dropped socket killed the session even with retries in
   * place. An async wrapper turns that throw into a rejection.
   */
  async #startGeneration(
    client: DeepdubSdkClient,
    text: string,
    options: TtsParams,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<unknown> {
    const result = await client.generateToBuffer(text, {
      ...options,
      headerless: true,
      onChunk,
    });
    this.#lastUsedAt = Date.now();
    return result;
  }

  usage() {
    if (this.#audioBytes === 0) {
      return [];
    }

    // PCM16 mono: 2 bytes per sample. The stream's rate is the configured
    // output rate; Deepdub's native rate (48 kHz) is the fallback.
    const sampleRate = resolveOutputSampleRate(this.voiceSlice.options);
    const seconds = this.#audioBytes / (2 * sampleRate);

    return [
      {
        provider: this.capabilities.id,
        kind: 'synthesize' as const,
        quantity: seconds,
        unit: 'seconds' as const,
        model:
          getVoiceModelOption(DEEPDUB_TTS_MODELS, this.voiceSlice.model)?.costModelKey ??
          DEEPDUB_TTS_MODELS[0]?.costModelKey ??
          'deepdub-phantom-x',
      },
    ];
  }

  #buildGenerationParams(params: unknown): TtsParams {
    const toneParams = isDeepdubToneParams(params) ? params : undefined;
    const generationParams: TtsParams = {
      voicePromptId: toneParams?.voiceId ?? this.voiceSlice.voiceId,
      model:
        toneParams?.model ?? this.voiceSlice.model ?? DEEPDUB_TTS_MODELS[0]?.id ?? 'dd-etts-3.2',
      locale: toneParams?.locale ?? this.voiceSlice.locale ?? 'en-US',
    };
    const targetGender =
      resolveDynamicGender(toneParams) ?? resolveDeepdubGender(this.voiceSlice.options);
    if (targetGender) {
      generationParams.targetGender = targetGender;
    }
    const accentControl = resolveDeepdubAccentControl(this.voiceSlice.options);
    if (accentControl) {
      generationParams.accentControl = accentControl;
    }
    if (toneParams) {
      generationParams.tempo = toneParams.tempo;
      generationParams.variance = toneParams.variance;
      generationParams.temperature = toneParams.temperature;
      generationParams.promptBoost = toneParams.promptBoost;
    }
    return generationParams;
  }

  async #getClient(): Promise<DeepdubSdkClient> {
    if (this.#client) {
      return this.#client;
    }
    if (this.#connectPromise) {
      return this.#connectPromise;
    }
    this.#connectPromise = (async () => {
      const factory = await resolveDeepdubClientFactory(this.credentials);
      const client = factory(this.credentials.apiKey ?? '', { protocol: 'websocket' });
      await client.connect();
      this.#client = client;
      return client;
    })();
    try {
      return await this.#connectPromise;
    } catch (error) {
      this.#connectPromise = undefined;
      throw error;
    }
  }
}

export const DEEPDUB_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: DEEPDUB_TTS_DESCRIPTOR,
  pricing: DEEPDUB_VOICE_PRICING,
  create(credentials, voiceSlice) {
    return new DeepdubTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, _context) {
    const factory = await resolveDeepdubClientFactory(credentials);
    const client = factory(credentials.apiKey ?? '', {
      protocol: 'http',
      baseUrl: resolveDeepdubRestBaseUrl(credentials),
    });
    if (typeof client.listVoices !== 'function') {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'DeepdubClient.listVoices is unavailable',
      );
    }
    const payload = await client.listVoices();
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const prompts = Array.isArray(record.voicePrompts) ? record.voicePrompts : [];
    return normalizeVoiceList({ voices: prompts }, { modelId });
  },
  clone: {
    capabilities: DEEPDUB_CLONE_CAPABILITIES,
    create(credentials) {
      return new DeepdubVoiceCloneProvider(credentials);
    },
    synthesizeWithVoiceReference: deepdubSynthesizeWithVoiceReference,
  },
};

function mapPace(pace: DeliveryTone['pace']): number {
  switch (pace) {
    case 'slow':
      return 0.85;
    case 'fast':
      return 1.15;
    default:
      return 1;
  }
}

function mapWarmth(warmth: DeliveryTone['warmth']): number {
  switch (warmth) {
    case 'low':
      return 0.2;
    case 'high':
      return 0.8;
    default:
      return 0.5;
  }
}

function mapEnergy(energy: DeliveryTone['energy']): number {
  switch (energy) {
    case 'low':
      return 0.25;
    case 'high':
      return 0.85;
    default:
      return 0.55;
  }
}

interface DeepdubToneParams {
  voiceId?: string;
  model?: string;
  tempo?: number;
  variance?: number;
  temperature?: number;
  promptBoost?: boolean;
  locale?: string;
  targetGender?: string;
  voiceReference?: string | Buffer | Uint8Array;
}

function isDeepdubToneParams(value: unknown): value is DeepdubToneParams {
  return typeof value === 'object' && value !== null;
}

function resolveDynamicGender(toneParams: DeepdubToneParams | undefined): string | undefined {
  const gender = toneParams?.targetGender;
  return typeof gender === 'string' && gender.length > 0 ? gender : undefined;
}

function resolveDeepdubGender(options: VoiceTtsConfig['options']): string | undefined {
  const configured = options?.targetGender;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

function resolveDeepdubAccentControl(
  options: VoiceTtsConfig['options'],
): TtsParams['accentControl'] {
  const configured = options?.accentControl;
  if (!configured || typeof configured !== 'object') {
    return undefined;
  }
  const record = configured as Record<string, unknown>;
  if (
    typeof record.accentBaseLocale === 'string' &&
    typeof record.accentLocale === 'string' &&
    typeof record.accentRatio === 'number'
  ) {
    return {
      accentBaseLocale: record.accentBaseLocale,
      accentLocale: record.accentLocale,
      accentRatio: record.accentRatio,
    };
  }
  return undefined;
}

function resolveVoiceReference(
  options: VoiceTtsConfig['options'],
  params: unknown,
): Buffer | Uint8Array | undefined {
  const fromParams =
    params && typeof params === 'object'
      ? (params as Record<string, unknown>).voiceReference
      : undefined;
  const raw = fromParams ?? options?.voiceReference;
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return raw;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return Buffer.from(raw, 'base64');
  }
  return undefined;
}

/**
 * Reconnect spacing. Overridable through the provider credentials options —
 * the same seam `deepdubClientFactory` uses — so tests do not pay real seconds.
 */
function resolveReconnectDelayMs(credentials: VoiceProviderCredentials): number {
  const configured = (credentials.options as Record<string, unknown> | undefined)?.reconnectDelayMs;
  return typeof configured === 'number' && configured >= 0 ? configured : RECONNECT_DELAY_MS;
}

/** Output PCM rate for usage metering: the configured rate, else Deepdub's native 48 kHz. */
function resolveOutputSampleRate(options: VoiceTtsConfig['options']): number {
  const configured = options?.sampleRate;
  return typeof configured === 'number' && configured > 0 ? configured : 48_000;
}

/** Idle window before a socket is replaced rather than trusted. Test seam. */
function resolveIdleReconnectMs(credentials: VoiceProviderCredentials): number {
  const configured = (credentials.options as Record<string, unknown> | undefined)?.idleReconnectMs;
  return typeof configured === 'number' && configured >= 0 ? configured : IDLE_RECONNECT_MS;
}

/** Abort-aware sleep: a barged-into turn must not wait out the backoff. */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isDeepdubDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('WebSocket is not connected') &&
    error.message.includes('connect() first')
  );
}

export type { DeepdubClientFactory };
