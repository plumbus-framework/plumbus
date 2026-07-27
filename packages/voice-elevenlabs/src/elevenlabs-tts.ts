import { ErrorCode, PlumbusError } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import {
  type DeliveryTone,
  normalizeVoiceList,
  type TTSProvider,
  type TTSProviderCatalogEntry,
  type TTSProviderRegistration,
  type VoicePersonaOption,
  type VoiceProviderCredentials,
  type VoiceTtsConfig,
} from '@plumbus/voice/provider-kit';
import {
  createElevenLabsCapabilities,
  DEFAULT_ELEVENLABS_TTS_MODEL_ID,
  ELEVENLABS_TTS_DESCRIPTOR,
} from './descriptor.js';
import { ELEVENLABS_VOICE_PRICING } from './pricing.js';

/**
 * Minimal structural surface of the official `@elevenlabs/elevenlabs-js` client we use.
 * Synthesis goes through `textToSpeech.stream()` for both flash and v3 models.
 */
interface ElevenLabsClientLike {
  textToSpeech: {
    stream(voiceId: string, request: ElevenLabsStreamRequest): Promise<ReadableStream<Uint8Array>>;
  };
  voices: {
    search(request?: Record<string, unknown>): Promise<{ voices?: unknown[] }>;
  };
}

interface ElevenLabsStreamRequest {
  text: string;
  modelId?: string;
  languageCode?: string;
  outputFormat?: string;
  voiceSettings?: {
    speed?: number;
    stability?: number;
    similarityBoost?: number;
  };
}

type ElevenLabsClientFactory = (options: {
  apiKey?: string;
  baseUrl?: string;
}) => ElevenLabsClientLike;

class ElevenLabsTTSProvider implements TTSProvider {
  readonly capabilities: TTSProviderCatalogEntry;
  #characters = 0;
  #client: ElevenLabsClientLike | undefined;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {
    this.capabilities = createElevenLabsCapabilities(voiceSlice.model);
  }

  mapDeliveryTone(tone: DeliveryTone) {
    if (this.capabilities.deliveryMode === 'inline-text-tags') {
      return {
        model: this.voiceSlice.model ?? 'eleven_v3',
        voiceId: this.voiceSlice.voiceId,
        tags: inferElevenLabsTags(tone),
        languageCode: resolveElevenLanguageCode(this.voiceSlice),
      };
    }

    assertFlashLocaleSupported(this.voiceSlice);
    return {
      model: this.voiceSlice.model ?? 'eleven_flash_v2_5',
      voiceId: this.voiceSlice.voiceId,
      speed: mapPace(tone.pace),
      stability: mapWarmth(tone.warmth),
      similarityBoost: mapEnergy(tone.energy),
      languageCode: resolveElevenLanguageCode(this.voiceSlice),
    };
  }

  applyDeliveryToText(text: string, tone: DeliveryTone): string {
    if (this.capabilities.deliveryMode !== 'inline-text-tags') {
      return text;
    }

    const tags = inferElevenLabsTags(tone);
    if (tags.length === 0) {
      return text;
    }

    return `${tags.join(' ')} ${text}`.trim();
  }

  async *synthesizeStream(text: string, params: unknown) {
    this.#characters += text.length;
    if (this.capabilities.deliveryMode !== 'inline-text-tags') {
      assertFlashLocaleSupported(this.voiceSlice);
    }

    const mapped = parseElevenToneParams(params) ?? this.mapDeliveryTone({});
    const voiceId = mapped.voiceId ?? this.voiceSlice.voiceId;
    if (!voiceId) {
      throw new PlumbusError(ErrorCode.Validation, 'ElevenLabs TTS requires voiceId.');
    }
    const client = await this.#getClient();
    const request: ElevenLabsStreamRequest = {
      text,
      modelId:
        mapped.model ??
        this.voiceSlice.model ??
        (this.capabilities.deliveryMode === 'inline-text-tags'
          ? 'eleven_v3'
          : DEFAULT_ELEVENLABS_TTS_MODEL_ID),
      languageCode: mapped.languageCode,
      outputFormat: resolveElevenOutputFormat(this.voiceSlice.options, 'mp3_44100_128'),
    };

    const voiceSettings = maybeVoiceSettings(
      mapped.speed,
      mapped.stability,
      mapped.similarityBoost,
    );
    if (voiceSettings) {
      request.voiceSettings = voiceSettings;
    }

    const stream = await client.textToSpeech.stream(voiceId, request);
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }
        if (value && value.length > 0) {
          yield value;
        }
      }
    } finally {
      reader.releaseLock();
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
        model: this.voiceSlice.model ?? DEFAULT_ELEVENLABS_TTS_MODEL_ID,
      },
    ];
  }

  async #getClient(): Promise<ElevenLabsClientLike> {
    if (this.#client) {
      return this.#client;
    }
    const factory = await resolveElevenLabsClientFactory(this.credentials);
    this.#client = factory({
      apiKey: this.credentials.apiKey,
      baseUrl: this.credentials.baseUrl,
    });
    return this.#client;
  }
}

export const ELEVENLABS_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: ELEVENLABS_TTS_DESCRIPTOR,
  pricing: ELEVENLABS_VOICE_PRICING,
  create(credentials, voiceSlice) {
    return new ElevenLabsTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId) {
    const factory = await resolveElevenLabsClientFactory(credentials);
    const client = factory({
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
    });
    const payload = await client.voices.search();
    const voices = normalizeVoiceList(payload, { modelId });
    return modelId ? filterVoicesByModel(voices, modelId) : voices;
  },
};

const elevenToneParamsSchema = z
  .object({
    model: z.string().optional(),
    voiceId: z.string().optional(),
    tags: z.array(z.string()).optional(),
    languageCode: z.string().optional(),
    speed: z.number().optional(),
    stability: z.number().optional(),
    similarityBoost: z.number().optional(),
  })
  .passthrough();

type ElevenToneParams = z.infer<typeof elevenToneParamsSchema>;

function parseElevenToneParams(value: unknown): ElevenToneParams | undefined {
  const parsed = elevenToneParamsSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function resolveElevenLanguageCode(voiceSlice: VoiceTtsConfig): string | undefined {
  const configured = voiceSlice.options?.languageCode;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }

  const locale = voiceSlice.locale?.toLowerCase();
  if (locale?.startsWith('he')) return 'heb';
  if (locale?.startsWith('en')) return 'eng';
  return undefined;
}

function assertFlashLocaleSupported(voiceSlice: VoiceTtsConfig): void {
  const languageCode = resolveElevenLanguageCode(voiceSlice);
  if (languageCode === 'heb' || voiceSlice.locale?.toLowerCase().startsWith('he')) {
    throw new PlumbusError(
      ErrorCode.Validation,
      'ElevenLabs flash does not support Hebrew; use eleven_v3, Deepdub, or MiniMax.',
    );
  }
}

function resolveElevenOutputFormat(options: VoiceTtsConfig['options'], fallback: string): string {
  const configured = options?.outputFormat;
  return typeof configured === 'string' && configured.length > 0 ? configured : fallback;
}

function maybeVoiceSettings(
  speed: number | undefined,
  stability: number | undefined,
  similarityBoost: number | undefined,
): ElevenLabsStreamRequest['voiceSettings'] | undefined {
  const settings: NonNullable<ElevenLabsStreamRequest['voiceSettings']> = {};
  if (typeof speed === 'number') settings.speed = speed;
  if (typeof stability === 'number') settings.stability = stability;
  if (typeof similarityBoost === 'number') settings.similarityBoost = similarityBoost;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function filterVoicesByModel(voices: VoicePersonaOption[], modelId: string): VoicePersonaOption[] {
  return voices.filter((voice) => {
    const supported = voice.metadata?.supported_models;
    if (!Array.isArray(supported)) {
      return true;
    }
    return supported.includes(modelId);
  });
}

function inferElevenLabsTags(tone: DeliveryTone): string[] {
  const tags: string[] = [];
  if (tone.emotion) {
    tags.push(`[${tone.emotion}]`);
  }
  if (tone.energy === 'low') {
    tags.push('[calm]');
  } else if (tone.energy === 'high') {
    tags.push('[excited]');
  }
  if (tone.warmth === 'high') {
    tags.push('[gentle]');
  }
  return tags;
}

function mapPace(pace: DeliveryTone['pace']): number {
  switch (pace) {
    case 'slow':
      return 0.8;
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
      return 0.75;
    default:
      return 0.5;
  }
}

function mapEnergy(energy: DeliveryTone['energy']): number {
  switch (energy) {
    case 'low':
      return 0.35;
    case 'high':
      return 0.85;
    default:
      return 0.6;
  }
}

async function resolveElevenLabsClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<ElevenLabsClientFactory> {
  const injected = (credentials.options as Record<string, unknown> | undefined)
    ?.elevenLabsClientFactory;
  if (typeof injected === 'function') {
    return injected as ElevenLabsClientFactory;
  }
  const imported = (await import('@elevenlabs/elevenlabs-js')) as {
    ElevenLabsClient?: new (options?: {
      apiKey?: string;
      baseUrl?: string;
    }) => ElevenLabsClientLike;
    default?: {
      ElevenLabsClient?: new (options?: {
        apiKey?: string;
        baseUrl?: string;
      }) => ElevenLabsClientLike;
    };
  };
  const ClientCtor = imported.ElevenLabsClient ?? imported.default?.ElevenLabsClient;
  if (typeof ClientCtor !== 'function') {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Unable to load ElevenLabsClient from @elevenlabs/elevenlabs-js',
    );
  }
  return (options) => new ClientCtor(options);
}
