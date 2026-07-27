import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  type DeliveryTone,
  normalizeVoiceList,
  type TTSProvider,
  type TTSProviderRegistration,
  type VoiceProviderCredentials,
  type VoiceTtsConfig,
} from '@plumbus/voice/provider-kit';
import { SONIOX_TTS_DESCRIPTOR, SONIOX_TTS_MODELS, SONIOX_TTS_VOICES } from './descriptor.js';
import { SONIOX_VOICE_PRICING } from './pricing.js';
import { SONIOX_CLONE_CAPABILITIES, SonioxVoiceCloneProvider } from './soniox-voice-clone.js';

/** Default matches `@plumbus/voice` transport PCM (`pcm16-16k`). SDK default is `wav`. */
const DEFAULT_PCM_SAMPLE_RATE = 16_000;
const DEFAULT_AUDIO_FORMAT = 'pcm_s16le';

interface SonioxTtsApiLike {
  generateStream(options: Record<string, unknown>): AsyncIterable<Uint8Array>;
  listModels?(signal?: AbortSignal): Promise<unknown>;
}

interface SonioxTtsClientLike {
  tts: SonioxTtsApiLike;
}

type SonioxTtsClientFactory = (apiKey: string) => SonioxTtsClientLike;

class SonioxTTSProvider implements TTSProvider {
  readonly capabilities = SONIOX_TTS_DESCRIPTOR;
  #characters = 0;
  #client: SonioxTtsClientLike | undefined;
  #clientFactory: SonioxTtsClientFactory | undefined;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {}

  mapDeliveryTone(_tone: DeliveryTone) {
    return {
      model: this.voiceSlice.model ?? SONIOX_TTS_MODELS[0]?.id ?? 'tts-rt-v1',
      voiceId: this.voiceSlice.voiceId ?? SONIOX_TTS_VOICES[0]?.id ?? 'Adrian',
      language: resolveSonioxLanguage(this.voiceSlice),
    };
  }

  async *synthesizeStream(text: string, params: unknown, signal?: AbortSignal) {
    this.#characters += text.length;
    const mapped = isSonioxToneParams(params) ? params : this.mapDeliveryTone({});
    const apiKey = this.credentials.apiKey;
    if (!apiKey) {
      throw new PlumbusError(ErrorCode.Validation, 'Soniox TTS provider requires an apiKey');
    }

    const client = await this.#getClient(apiKey);
    const options = {
      text,
      voice: mapped.voiceId ?? SONIOX_TTS_VOICES[0]?.id ?? 'Adrian',
      model: mapped.model ?? SONIOX_TTS_MODELS[0]?.id ?? 'tts-rt-v1',
      language: mapped.language ?? 'en',
      audio_format: resolveAudioFormat(this.voiceSlice.options),
      sample_rate: resolveSampleRate(this.voiceSlice.options),
      ...(resolveBitrate(this.voiceSlice.options)
        ? { bitrate: resolveBitrate(this.voiceSlice.options) }
        : {}),
      ...(signal ? { signal } : {}),
    };

    try {
      for await (const chunk of client.tts.generateStream(options)) {
        yield chunk;
      }
    } catch (error) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `Soniox TTS request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
        model: 'soniox-tts',
      },
    ];
  }

  async #getClient(apiKey: string): Promise<SonioxTtsClientLike> {
    if (!this.#client) {
      if (!this.#clientFactory) {
        this.#clientFactory = await resolveSonioxTtsClientFactory(this.credentials);
      }
      this.#client = this.#clientFactory(apiKey);
    }
    return this.#client;
  }
}

export const SONIOX_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: SONIOX_TTS_DESCRIPTOR,
  pricing: SONIOX_VOICE_PRICING['soniox-tts'],
  create(credentials, voiceSlice) {
    return new SonioxTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, _context) {
    const apiKey = credentials.apiKey;
    if (!apiKey) {
      throw new PlumbusError(ErrorCode.Validation, 'Soniox TTS listVoices requires an apiKey');
    }
    const factory = await resolveSonioxTtsClientFactory(credentials);
    const client = factory(apiKey);
    if (typeof client.tts.listModels !== 'function') {
      return staticSonioxVoices(modelId);
    }

    const models = await client.tts.listModels();
    const modelList = Array.isArray(models) ? models : [];
    const voices = modelList.flatMap((model) => {
      const record = model && typeof model === 'object' ? (model as Record<string, unknown>) : {};
      const modelVoices = Array.isArray(record.voices) ? record.voices : [];
      return modelVoices;
    });
    if (voices.length === 0) {
      return staticSonioxVoices(modelId);
    }
    return normalizeVoiceList(voices, { modelId });
  },
  clone: {
    capabilities: SONIOX_CLONE_CAPABILITIES,
    create(credentials) {
      return new SonioxVoiceCloneProvider(credentials);
    },
  },
};

function staticSonioxVoices(modelId: string | undefined) {
  return SONIOX_TTS_VOICES.map((voice) => ({
    ...voice,
    modelId: modelId ?? voice.modelId,
  }));
}

interface SonioxToneParams {
  model?: string;
  voiceId?: string;
  language?: string;
}

function isSonioxToneParams(value: unknown): value is SonioxToneParams {
  return typeof value === 'object' && value !== null;
}

function resolveSonioxLanguage(voiceSlice: VoiceTtsConfig): string {
  const configured = voiceSlice.options?.language;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }
  const locale = voiceSlice.locale;
  if (typeof locale === 'string' && locale.length > 0) {
    const [language] = locale.split('-');
    if (language && language.length > 0) {
      return language.toLowerCase();
    }
  }
  return 'en';
}

function resolveAudioFormat(options: VoiceTtsConfig['options']): string {
  const configured = options?.format ?? options?.audioFormat;
  return typeof configured === 'string' && configured.length > 0
    ? configured
    : DEFAULT_AUDIO_FORMAT;
}

function resolveSampleRate(options: VoiceTtsConfig['options']): number {
  const configured = options?.sampleRate;
  return typeof configured === 'number' ? configured : DEFAULT_PCM_SAMPLE_RATE;
}

function resolveBitrate(options: VoiceTtsConfig['options']): number | undefined {
  const configured = options?.bitrate;
  return typeof configured === 'number' ? configured : undefined;
}

async function resolveSonioxTtsClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<SonioxTtsClientFactory> {
  const options = credentials.options as Record<string, unknown> | undefined;
  const injectedTts = options?.sonioxTtsClientFactory;
  if (typeof injectedTts === 'function') {
    return injectedTts as SonioxTtsClientFactory;
  }

  // Allow STT-style factories that already return a full SDK client with `.tts`.
  const injectedShared = options?.sonioxClientFactory;
  if (typeof injectedShared === 'function') {
    return (apiKey: string) => {
      const client = (injectedShared as (apiKey: string) => unknown)(apiKey);
      if (
        client &&
        typeof client === 'object' &&
        'tts' in client &&
        typeof (client as SonioxTtsClientLike).tts?.generateStream === 'function'
      ) {
        return client as SonioxTtsClientLike;
      }
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Injected sonioxClientFactory must return a client with tts.generateStream()',
      );
    };
  }

  const imported = (await import('@soniox/node')) as {
    SonioxNodeClient?: new (options: { api_key: string }) => SonioxTtsClientLike;
    default?: {
      SonioxNodeClient?: new (options: { api_key: string }) => SonioxTtsClientLike;
    };
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
