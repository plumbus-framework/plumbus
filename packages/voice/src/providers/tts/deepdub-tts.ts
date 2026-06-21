import type { TtsParams } from '@deepdub/node';
import { DEEPDUB_TTS_MODELS } from '../../catalog/static-models.js';
import type { TTSProviderCatalogEntry, VoiceProviderCredentials } from '../../types/provider.js';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { fetchCatalogJson, normalizeVoiceList } from '../base/catalog-http.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';

const DEEPDUB_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'deepdub',
  kind: 'tts',
  displayName: 'Deepdub',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'full',
  deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
  deliveryMode: 'native-params',
  hebrewQuality: 'strong',
  knownModels: [...DEEPDUB_TTS_MODELS],
  voicesSource: 'live-api',
};

/**
 * Minimal structural surface of the official `@deepdub/node` SDK client we use.
 * We synthesize through the SDK (not a hand-rolled WebSocket) so the request and
 * audio handling are byte-for-byte identical to Deepdub Studio / the SDK example,
 * which is the configuration that pronounces Hebrew correctly.
 */
interface DeepdubSdkClient {
  connect(): Promise<unknown>;
  generateToBuffer(text: string, params?: TtsParams): Promise<unknown>;
  disconnect?(): void;
}

type DeepdubClientFactory = (
  apiKey: string,
  options: { protocol: 'websocket' },
) => DeepdubSdkClient;

class DeepdubTTSProvider implements TTSProvider {
  readonly capabilities = DEEPDUB_TTS_DESCRIPTOR;
  #characters = 0;
  #client: DeepdubSdkClient | undefined;
  #connectPromise: Promise<DeepdubSdkClient> | undefined;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {}

  mapDeliveryTone(tone: DeliveryTone) {
    return {
      voiceId: this.voiceSlice.voiceId,
      model: this.voiceSlice.model ?? DEEPDUB_TTS_MODELS[0]?.id,
      tempo: mapPace(tone.pace),
      variance: mapWarmth(tone.warmth),
      temperature: mapEnergy(tone.energy),
      promptBoost: Boolean(tone.emotion && tone.emotion !== 'neutral'),
      locale: this.voiceSlice.locale,
      // Per-turn gender override (e.g. detected subject gender). Falls through to
      // the static voice option in `#buildGenerationParams` when not provided.
      targetGender: tone.targetGender,
    };
  }

  async *synthesizeStream(text: string, params: unknown, signal?: AbortSignal) {
    this.#characters += text.length;
    const client = await this.#getClient();
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

    console.info('[voice-tts] deepdub synthesis requested', {
      characters: text.length,
      model: options.model,
      locale: options.locale,
      via: 'sdk',
    });

    const generation = this.#startGeneration(client, text, options, (chunk) => {
      if (!chunk || chunk.length === 0) return;
      if (!firstChunkLogged) {
        firstChunkLogged = true;
        console.info('[voice-tts] first deepdub audio chunk received', {
          bytes: chunk.byteLength,
        });
      }
      queue.push(chunk);
      wake?.();
    })
      .then(() => {
        finished = true;
        wake?.();
      })
      .catch(async (error: unknown) => {
        if (!isDeepdubDisconnectedError(error)) {
          failure = error instanceof Error ? error : new Error(String(error));
          finished = true;
          wake?.();
          return;
        }
        console.warn('[voice-tts] deepdub websocket dropped — reconnecting once', {
          message: error instanceof Error ? error.message : String(error),
        });
        this.#resetClient();
        try {
          const retryClient = await this.#getClient();
          await this.#startGeneration(retryClient, text, options, (chunk) => {
            if (!chunk || chunk.length === 0) return;
            if (!firstChunkLogged) {
              firstChunkLogged = true;
              console.info('[voice-tts] first deepdub audio chunk received', {
                bytes: chunk.byteLength,
              });
            }
            queue.push(chunk);
            wake?.();
          });
          finished = true;
          wake?.();
        } catch (retryError: unknown) {
          failure = retryError instanceof Error ? retryError : new Error(String(retryError));
          finished = true;
          wake?.();
        }
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

  #startGeneration(
    client: DeepdubSdkClient,
    text: string,
    options: TtsParams,
    onChunk: (chunk: Uint8Array) => void,
  ): Promise<unknown> {
    return client.generateToBuffer(text, {
      ...options,
      headerless: true,
      onChunk,
    });
  }

  usage() {
    if (this.#characters === 0) {
      return [];
    }

    return [
      {
        provider: this.capabilities.id,
        kind: 'synthesize' as const,
        quantity: this.#characters,
        unit: 'characters' as const,
        model: this.voiceSlice.model ?? DEEPDUB_TTS_MODELS[0]?.costModelKey ?? 'deepdub-phantom-x',
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
    // Prefer a per-turn gender from the resolved tone (detected subject gender);
    // fall back to the statically configured voice option.
    const targetGender =
      resolveDynamicGender(toneParams) ?? resolveDeepdubGender(this.voiceSlice.options);
    if (targetGender) {
      generationParams.targetGender = targetGender;
    }
    const accentControl = resolveDeepdubAccentControl(this.voiceSlice.options);
    if (accentControl) {
      generationParams.accentControl = accentControl;
    }
    // Delivery-shaping params are only sent when a tone profile is active. With the
    // default tone (none resolved) we omit them so Deepdub uses its own defaults —
    // matching the SDK example that produces correct Hebrew.
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
  create(credentials, voiceSlice) {
    return new DeepdubTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, context) {
    const baseUrl = credentials.baseUrl ?? 'https://api.deepdub.com';
    const payload = await fetchCatalogJson(credentials, context.fetcher, `${baseUrl}/v1/voices`);
    return normalizeVoiceList(payload, { modelId });
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

function isDeepdubDisconnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('WebSocket is not connected') &&
    error.message.includes('connect() first')
  );
}

async function resolveDeepdubClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<DeepdubClientFactory> {
  const injected = (credentials.options as Record<string, unknown> | undefined)
    ?.deepdubClientFactory;
  if (typeof injected === 'function') {
    return injected as DeepdubClientFactory;
  }
  const imported = (await import('@deepdub/node')) as {
    DeepdubClient?: new (apiKey: string, options: { protocol: 'websocket' }) => DeepdubSdkClient;
    default?: {
      DeepdubClient?: new (apiKey: string, options: { protocol: 'websocket' }) => DeepdubSdkClient;
    };
  };
  const ClientCtor = imported.DeepdubClient ?? imported.default?.DeepdubClient;
  if (typeof ClientCtor !== 'function') {
    throw new Error('Unable to load DeepdubClient from @deepdub/node');
  }
  return (apiKey, options) => new ClientCtor(apiKey, options);
}
