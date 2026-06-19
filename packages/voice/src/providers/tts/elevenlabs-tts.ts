import type {
  TTSProviderCatalogEntry,
  VoicePersonaOption,
  VoiceProviderCredentials,
} from '../../types/provider.js';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { ELEVENLABS_TTS_MODELS, getVoiceModelOption } from '../../catalog/static-models.js';
import { fetchCatalogJson, normalizeVoiceList } from '../base/catalog-http.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';
import type { TTSWebSocket } from './wire.js';
import {
  assertOkResponse,
  decodeBase64Audio,
  httpToWebSocketUrl,
  joinUrl,
  readResponseChunks,
  resolveTtsFetch,
  resolveTtsWebSocketFactory,
  socketMessageToString,
} from './wire.js';

const ELEVENLABS_TTS_DESCRIPTOR = createElevenLabsCapabilities();

class ElevenLabsTTSProvider implements TTSProvider {
  readonly capabilities: TTSProviderCatalogEntry;
  #characters = 0;

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
    if (this.capabilities.deliveryMode === 'inline-text-tags') {
      yield* this.#synthesizeV3(text, params);
      return;
    }

    yield* this.#synthesizeFlash(text, params);
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
        model: this.voiceSlice.model ?? 'eleven_flash_v2_5',
      },
    ];
  }

  async *#synthesizeFlash(text: string, params: unknown): AsyncIterable<Uint8Array> {
    assertFlashLocaleSupported(this.voiceSlice);
    const mapped = isElevenFlashParams(params) ? params : this.mapDeliveryTone({});
    const baseUrl = resolveElevenBaseUrl(this.credentials.baseUrl);
    const voiceId = mapped.voiceId ?? this.voiceSlice.voiceId;
    const wsBase = httpToWebSocketUrl(baseUrl).replace(/\/+$/, '');
    const url = `${wsBase}/v1/text-to-speech/${voiceId}/stream-input?model_id=${encodeURIComponent(
      mapped.model ?? 'eleven_flash_v2_5',
    )}&output_format=${encodeURIComponent(resolveElevenOutputFormat(this.voiceSlice.options, 'mp3_44100_128'))}`;
    const socket = resolveTtsWebSocketFactory(this.credentials)(url);

    await waitForSocketOpen(socket, 'ElevenLabs flash');
    const stream = streamSocketJson(socket);
    socket.send(
      JSON.stringify({
        text: ' ',
        xi_api_key: this.credentials.apiKey,
        language_code: mapped.languageCode,
        voice_settings: maybeVoiceSettings(mapped.speed, mapped.stability, mapped.similarityBoost),
        generation_config: {
          chunk_length_schedule: resolveChunkSchedule(this.voiceSlice.options),
        },
      }),
    );
    socket.send(JSON.stringify({ text }));
    socket.send(JSON.stringify({ text: '', flush: true }));

    try {
      for await (const message of stream) {
        const audio = typeof message.audio === 'string' ? message.audio : undefined;
        if (audio) {
          yield decodeBase64Audio(audio);
        }
        if (message.isFinal === true) {
          return;
        }
      }
    } finally {
      socket.close();
    }
  }

  async *#synthesizeV3(text: string, params: unknown): AsyncIterable<Uint8Array> {
    const mapped = isElevenV3Params(params) ? params : this.mapDeliveryTone({});
    const baseUrl = resolveElevenBaseUrl(this.credentials.baseUrl);
    const voiceId = mapped.voiceId ?? this.voiceSlice.voiceId;
    const url = joinUrl(baseUrl, `v1/text-to-speech/${voiceId}`);
    const response = await resolveTtsFetch(this.credentials)(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.credentials.apiKey ?? '',
        'Content-Type': 'application/json',
        Accept: 'application/octet-stream',
      },
      body: JSON.stringify({
        text,
        model_id: mapped.model ?? 'eleven_v3',
        language_code: mapped.languageCode ?? 'heb',
        output_format: resolveElevenOutputFormat(this.voiceSlice.options, 'mp3_44100_128'),
      }),
    });

    await assertOkResponse(response, url);
    for await (const chunk of readResponseChunks(response)) {
      if (chunk.length > 0) {
        yield chunk;
      }
    }
  }
}

export const ELEVENLABS_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: ELEVENLABS_TTS_DESCRIPTOR,
  create(credentials, voiceSlice) {
    return new ElevenLabsTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, context) {
    const baseUrl = credentials.baseUrl ?? 'https://api.elevenlabs.io';
    const payload = await fetchCatalogJson(credentials, context.fetcher, `${baseUrl}/v1/voices`);
    const voices = normalizeVoiceList(payload, { modelId });
    return modelId ? filterVoicesByModel(voices, modelId) : voices;
  },
};

export function createElevenLabsCapabilities(modelId?: string): TTSProviderCatalogEntry {
  const resolvedModel =
    getVoiceModelOption(ELEVENLABS_TTS_MODELS, modelId)?.id ?? 'eleven_flash_v2_5';
  const isV3 = resolvedModel === 'eleven_v3';

  return {
    id: 'elevenlabs',
    kind: 'tts',
    displayName: 'ElevenLabs',
    credentialSchema: [{ field: 'apiKey', required: true }],
    hosting: 'cloud',
    execution: 'server',
    streaming: !isV3,
    toneSupport: isV3 ? 'partial' : 'partial',
    deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
    deliveryMode: isV3 ? 'inline-text-tags' : 'native-params',
    hebrewQuality: isV3 ? 'good' : 'limited',
    knownModels: [...ELEVENLABS_TTS_MODELS],
    voicesSource: 'live-api',
  };
}

interface ElevenFlashParams {
  model?: string;
  voiceId?: string;
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  languageCode?: string;
}

interface ElevenV3Params {
  model?: string;
  voiceId?: string;
  tags?: string[];
  languageCode?: string;
}

function isElevenFlashParams(value: unknown): value is ElevenFlashParams {
  return typeof value === 'object' && value !== null;
}

function isElevenV3Params(value: unknown): value is ElevenV3Params {
  return typeof value === 'object' && value !== null;
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

async function waitForSocketOpen(socket: TTSWebSocket, label: string) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    socket.on('open', () => {
      settled = true;
      resolve();
    });
    socket.on('error', (error) => {
      if (!settled) {
        reject(new Error(`${label} websocket failed to connect: ${error.message}`));
      }
    });
  });
}

async function* streamSocketJson(socket: TTSWebSocket): AsyncIterable<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = [];
  let closed = false;
  let failure: Error | undefined;
  let notify: (() => void) | undefined;

  socket.on('message', (data) => {
    queue.push(JSON.parse(socketMessageToString(data)) as Record<string, unknown>);
    notify?.();
    notify = undefined;
  });
  socket.on('close', () => {
    closed = true;
    notify?.();
    notify = undefined;
  });
  socket.on('error', (error) => {
    failure = error;
    notify?.();
    notify = undefined;
  });

  while (queue.length > 0 || !closed) {
    if (queue.length === 0) {
      if (failure) {
        throw failure;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      continue;
    }

    const next = queue.shift();
    if (next) {
      yield next;
    }
  }

  if (failure) {
    throw failure;
  }
}

function resolveElevenBaseUrl(baseUrl: string | undefined): string {
  return baseUrl ?? 'https://api.elevenlabs.io';
}

function resolveElevenOutputFormat(options: VoiceTtsConfig['options'], fallback: string): string {
  const configured = options?.outputFormat;
  return typeof configured === 'string' && configured.length > 0 ? configured : fallback;
}

function resolveChunkSchedule(options: VoiceTtsConfig['options']): number[] {
  const configured = options?.chunkLengthSchedule;
  if (
    Array.isArray(configured) &&
    configured.every((value): value is number => typeof value === 'number')
  ) {
    return configured;
  }
  return [120, 160, 250, 290];
}

function maybeVoiceSettings(
  speed: number | undefined,
  stability: number | undefined,
  similarityBoost: number | undefined,
): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = {};
  if (typeof speed === 'number') settings.speed = speed;
  if (typeof stability === 'number') settings.stability = stability;
  if (typeof similarityBoost === 'number') settings.similarity_boost = similarityBoost;
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
