import type { TTSProviderCatalogEntry } from '../../types/provider.js';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { MINIMAX_TTS_MODELS } from '../../catalog/static-models.js';
import { fetchCatalogJson, normalizeVoiceList } from '../base/catalog-http.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';
import type { TTSWebSocket } from './wire.js';
import {
  assertOkResponse,
  decodeHexAudio,
  httpToWebSocketUrl,
  joinUrl,
  readResponseChunks,
  resolveTtsFetch,
  resolveTtsWebSocketFactory,
  socketMessageToString,
} from './wire.js';

const MINIMAX_TTS_DESCRIPTOR: TTSProviderCatalogEntry = {
  id: 'minimax',
  kind: 'tts',
  displayName: 'MiniMax',
  credentialSchema: [{ field: 'apiKey', required: true }],
  hosting: 'cloud',
  execution: 'server',
  streaming: true,
  toneSupport: 'full',
  deliveryAxes: ['pace', 'warmth', 'energy', 'emotion'],
  deliveryMode: 'native-params',
  languageBoost: true,
  hebrewQuality: 'good',
  knownModels: [...MINIMAX_TTS_MODELS],
  voicesSource: 'live-api',
};

type MiniMaxStreamingMode = 'http' | 'websocket';

class MiniMaxTTSProvider implements TTSProvider {
  readonly capabilities = MINIMAX_TTS_DESCRIPTOR;
  #characters = 0;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {}

  mapDeliveryTone(tone: DeliveryTone) {
    return {
      model: this.voiceSlice.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo',
      voiceId: this.voiceSlice.voiceId,
      speed: mapPace(tone.pace),
      pitch: mapWarmth(tone.warmth),
      vol: mapEnergy(tone.energy),
      emotion: resolveMiniMaxEmotion(tone),
      languageBoost:
        this.voiceSlice.options?.languageBoost ??
        (this.voiceSlice.locale?.startsWith('he') ? 'Hebrew' : undefined),
    };
  }

  async *synthesizeStream(text: string, params: unknown) {
    this.#characters += text.length;
    const mode = resolveStreamingMode(this.voiceSlice.options);
    if (mode === 'websocket') {
      yield* this.synthesizeStreamWebSocket(text, params);
      return;
    }
    yield* this.synthesizeStreamHttp(text, params);
  }

  async *synthesizeStreamHttp(text: string, params: unknown) {
    const request = resolveTtsFetch(this.credentials);
    const url = joinUrl(this.credentials.baseUrl ?? 'https://api.minimax.io', 'v1/t2a_v2');
    const mapped = isMiniMaxToneParams(params) ? params : this.mapDeliveryTone({});
    const response = await request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: mapped.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo',
        text,
        stream: true,
        output_format: 'hex',
        stream_options: {
          exclude_aggregated_audio: true,
        },
        language_boost: mapped.languageBoost,
        voice_setting: {
          voice_id: mapped.voiceId,
          speed: mapped.speed,
          pitch: mapped.pitch,
          vol: mapped.vol,
          emotion: mapped.emotion,
        },
        audio_setting: buildAudioSetting(this.voiceSlice.options),
      }),
    });

    await assertOkResponse(response, url);
    yield* decodeMiniMaxEventStream(response);
  }

  async *synthesizeStreamWebSocket(text: string, params: unknown) {
    const mapped = isMiniMaxToneParams(params) ? params : this.mapDeliveryTone({});
    const baseUrl = this.credentials.baseUrl ?? 'https://api.minimax.io';
    const wsUrl = `${httpToWebSocketUrl(baseUrl).replace(/\/+$/, '')}/ws/v1/t2a_v2`;
    const socket = resolveTtsWebSocketFactory(this.credentials)(wsUrl, {
      headers: { Authorization: `Bearer ${this.credentials.apiKey ?? ''}` },
    });

    await waitForSocketOpen(socket, 'MiniMax');
    const stream = createMiniMaxMessageStream(socket);
    let phase: 'connect' | 'start' | 'stream' = 'connect';

    try {
      for await (const message of stream) {
        const event = typeof message.event === 'string' ? message.event : '';

        if (phase === 'connect') {
          if (event !== 'connected_success') {
            continue;
          }
          socket.send(
            JSON.stringify({
              event: 'task_start',
              model: mapped.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo',
              language_boost: mapped.languageBoost,
              voice_setting: {
                voice_id: mapped.voiceId,
                speed: mapped.speed,
                pitch: mapped.pitch,
                vol: mapped.vol,
                emotion: mapped.emotion,
              },
              audio_setting: buildAudioSetting(this.voiceSlice.options),
            }),
          );
          phase = 'start';
          continue;
        }

        if (phase === 'start') {
          if (event !== 'task_started') {
            continue;
          }
          socket.send(JSON.stringify({ event: 'task_continue', text }));
          socket.send(JSON.stringify({ event: 'task_finish' }));
          phase = 'stream';
          continue;
        }

        if (event === 'task_continued' || event === 'task_continue') {
          const audio = getNestedString(message, ['data', 'audio']);
          if (audio) {
            yield decodeHexAudio(audio);
          }
        }
        if (event === 'task_finished' || event === 'task_finish') {
          return;
        }
      }
    } finally {
      socket.close();
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
        model:
          this.voiceSlice.model === 'speech-2.8-hd'
            ? 'minimax-speech-2.8-hd'
            : 'minimax-speech-2.8-turbo',
      },
    ];
  }
}

export const MINIMAX_TTS_REGISTRATION: TTSProviderRegistration = {
  descriptor: MINIMAX_TTS_DESCRIPTOR,
  create(credentials, voiceSlice) {
    return new MiniMaxTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, context) {
    const baseUrl = credentials.baseUrl ?? 'https://api.minimax.io';
    const payload = await fetchCatalogJson(credentials, context.fetcher, `${baseUrl}/v1/voices`);
    return normalizeVoiceList(payload, { modelId });
  },
};

function resolveStreamingMode(options: VoiceTtsConfig['options']): MiniMaxStreamingMode {
  const configured = options?.streamingMode;
  return configured === 'websocket' ? 'websocket' : 'http';
}

function buildAudioSetting(options: VoiceTtsConfig['options']) {
  return {
    sample_rate: resolveSampleRate(options, 32_000),
    bitrate: resolveBitrate(options, 128_000),
    format: resolveAudioFormat(options),
    channel: resolveChannel(options, 1),
  };
}

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
      return -0.15;
    case 'high':
      return 0.15;
    default:
      return 0;
  }
}

function mapEnergy(energy: DeliveryTone['energy']): number {
  switch (energy) {
    case 'low':
      return 0.8;
    case 'high':
      return 1.2;
    default:
      return 1;
  }
}

interface MiniMaxToneParams {
  model?: string;
  voiceId?: string;
  speed?: number;
  pitch?: number;
  vol?: number;
  emotion?: string;
  languageBoost?: string;
}

function isMiniMaxToneParams(value: unknown): value is MiniMaxToneParams {
  return typeof value === 'object' && value !== null;
}

function resolveMiniMaxEmotion(tone: DeliveryTone): string | undefined {
  const explicit = normalizeEmotionLabel(tone.emotion);
  if (explicit) {
    return explicit;
  }
  if (tone.energy === 'high') {
    return 'happy';
  }
  if (tone.energy === 'low' || tone.warmth === 'high') {
    return 'calm';
  }
  return undefined;
}

function normalizeEmotionLabel(emotion: string | undefined): string | undefined {
  if (!emotion) {
    return undefined;
  }

  const candidate = emotion.toLowerCase().trim();
  return SUPPORTED_MINIMAX_EMOTIONS.has(candidate) ? candidate : undefined;
}

async function* decodeMiniMaxEventStream(
  response: Parameters<typeof readResponseChunks>[0],
): AsyncIterable<Uint8Array> {
  let buffer = '';
  for await (const chunk of readResponseChunks(response)) {
    buffer += Buffer.from(chunk).toString('utf8');

    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) {
        break;
      }

      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = parseSseJsonFrame(frame);
      if (!payload) {
        continue;
      }

      const audio = getNestedString(payload, ['data', 'audio']);
      if (audio) {
        yield decodeHexAudio(audio);
      }
    }
  }
}

function parseSseJsonFrame(frame: string): Record<string, unknown> | undefined {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .join('');

  if (!data) {
    return undefined;
  }

  return JSON.parse(data) as Record<string, unknown>;
}

function getNestedString(payload: Record<string, unknown>, path: string[]): string | undefined {
  let current: unknown = payload;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' && current.length > 0 ? current : undefined;
}

function resolveSampleRate(options: VoiceTtsConfig['options'], fallback: number): number {
  const configured = options?.sampleRate;
  return typeof configured === 'number' ? configured : fallback;
}

function resolveBitrate(options: VoiceTtsConfig['options'], fallback: number): number {
  const configured = options?.bitrate;
  return typeof configured === 'number' ? configured : fallback;
}

function resolveChannel(options: VoiceTtsConfig['options'], fallback: number): number {
  const configured = options?.channel;
  return typeof configured === 'number' ? configured : fallback;
}

function resolveAudioFormat(options: VoiceTtsConfig['options']): string {
  const configured = options?.format;
  return typeof configured === 'string' && configured.length > 0 ? configured : 'mp3';
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

async function* createMiniMaxMessageStream(
  socket: TTSWebSocket,
): AsyncIterable<Record<string, unknown>> {
  const queue: Array<Record<string, unknown>> = [];
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
    yield queue.shift()!;
  }
}

const SUPPORTED_MINIMAX_EMOTIONS = new Set([
  'happy',
  'sad',
  'angry',
  'fearful',
  'disgusted',
  'surprised',
  'calm',
  'fluent',
  'whisper',
]);
