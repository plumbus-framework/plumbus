import type { TTSProviderCatalogEntry } from '../../types/provider.js';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from '../../catalog/static-models.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';
import {
  assertOkResponse,
  joinUrl,
  readResponseChunks,
  resolveTtsFetch,
} from './wire.js';

const OPENAI_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'openai',
  kind: 'tts',
  displayName: 'OpenAI TTS',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'pace-only',
  deliveryAxes: ['pace'],
  deliveryMode: 'native-params',
  hebrewQuality: 'limited',
  knownModels: [...OPENAI_TTS_MODELS],
  knownVoices: [...OPENAI_TTS_VOICES],
  voicesSource: 'static',
};

class OpenAITTSProvider implements TTSProvider {
  readonly capabilities = OPENAI_TTS_DESCRIPTOR;
  #characters = 0;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {}

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
    const baseUrl = this.credentials.baseUrl ?? 'https://api.openai.com/v1';
    const url = joinUrl(baseUrl, 'audio/speech');
    const request = resolveTtsFetch(this.credentials);
    const mapped = isOpenAIToneParams(params) ? params : this.mapDeliveryTone({});
    const response = await request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
        Accept: 'application/octet-stream',
      },
      body: JSON.stringify({
        model: mapped.model,
        voice: mapped.voice,
        input: text,
        speed: mapped.speed,
        response_format: resolveOpenAIResponseFormat(this.voiceSlice.options),
        instructions: resolveOpenAIInstructions(this.voiceSlice.options),
      }),
    });

    await assertOkResponse(response, url);
    for await (const chunk of readResponseChunks(response)) {
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
}

export const OPENAI_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: OPENAI_TTS_DESCRIPTOR,
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
