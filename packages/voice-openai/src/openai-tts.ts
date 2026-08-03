import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  type DeliveryTone,
  readResponseChunks,
  type TTSProvider,
  type TTSProviderRegistration,
  type VoiceProviderCredentials,
  type VoiceTtsConfig,
} from '@plumbus/voice/provider-kit';
import { OPENAI_TTS_DESCRIPTOR, OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from './descriptor.js';
import {
  type OpenAIAudioClientLike,
  resolveOpenAIBaseURL,
  resolveOpenAIClientFactory,
} from './openai-client.js';
import { OPENAI_VOICE_PRICING } from './pricing.js';

class OpenAITTSProvider implements TTSProvider {
  readonly capabilities = OPENAI_TTS_DESCRIPTOR;
  readonly #baseURL: string | undefined;
  readonly #clientFactory: ReturnType<typeof resolveOpenAIClientFactory>;
  #characters = 0;
  #client: OpenAIAudioClientLike | undefined;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {
    this.#baseURL = resolveOpenAIBaseURL(credentials);
    this.#clientFactory = resolveOpenAIClientFactory(credentials);
  }

  mapDeliveryTone(tone: DeliveryTone) {
    return {
      model: this.voiceSlice.model ?? OPENAI_TTS_MODELS[0]?.id ?? 'tts-1',
      voice: this.voiceSlice.voiceId ?? OPENAI_TTS_VOICES[0]?.id ?? 'alloy',
      speed: mapPace(tone.pace),
      locale: this.voiceSlice.locale,
    };
  }

  async *synthesizeStream(text: string, params: unknown) {
    this.#characters += text.length;
    const mapped = isOpenAIToneParams(params) ? params : this.mapDeliveryTone({});
    const client = this.#getClient();
    const apiKey = this.credentials.apiKey;
    if (!apiKey) {
      throw new PlumbusError(ErrorCode.Validation, 'OpenAI TTS provider requires an apiKey');
    }

    let response: Response;
    try {
      response = await client.audio.speech.create({
        model: mapped.model,
        voice: mapped.voice,
        input: text,
        speed: mapped.speed,
        response_format: resolveOpenAIResponseFormat(this.voiceSlice.options),
        ...(resolveOpenAIInstructions(this.voiceSlice.options)
          ? { instructions: resolveOpenAIInstructions(this.voiceSlice.options) }
          : {}),
      });
    } catch (error) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `OpenAI speech request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `OpenAI speech request failed with status ${response.status}`,
      );
    }

    for await (const chunk of readResponseChunks({
      body: response.body ?? undefined,
    })) {
      yield chunk;
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
        model: this.voiceSlice.model ?? OPENAI_TTS_MODELS[0]?.id ?? 'tts-1',
      },
    ];
  }

  #getClient(): OpenAIAudioClientLike {
    if (!this.#client) {
      const apiKey = this.credentials.apiKey;
      if (!apiKey) {
        throw new PlumbusError(ErrorCode.Validation, 'OpenAI TTS provider requires an apiKey');
      }
      this.#client = this.#clientFactory({
        apiKey,
        baseURL: this.#baseURL,
      });
    }
    return this.#client;
  }
}

export const OPENAI_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: OPENAI_TTS_DESCRIPTOR,
  pricing: Object.values(OPENAI_VOICE_PRICING).filter((entry) => entry.operation === 'synthesize'),
  create(credentials, voiceSlice) {
    return new OpenAITTSProvider(credentials, voiceSlice);
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

interface OpenAIToneParams {
  model: string;
  voice: string;
  speed: number;
  locale?: string;
}

function isOpenAIToneParams(value: unknown): value is OpenAIToneParams {
  return typeof value === 'object' && value !== null;
}

function resolveOpenAIResponseFormat(options: VoiceTtsConfig['options']): string {
  const configured = options?.responseFormat;
  return typeof configured === 'string' && configured.length > 0 ? configured : 'mp3';
}

function resolveOpenAIInstructions(options: VoiceTtsConfig['options']): string | undefined {
  const configured = options?.instructions;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}
