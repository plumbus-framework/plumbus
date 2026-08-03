import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  assertOkResponse,
  type DeliveryTone,
  decodeHexAudio,
  fetchCatalogJson,
  httpToWebSocketUrl,
  joinUrl,
  normalizeVoiceList,
  readResponseChunks,
  resolveTtsFetch,
  resolveTtsWebSocketFactory,
  socketMessageToString,
  type TTSProvider,
  type TTSProviderRegistration,
  type TTSWebSocket,
  type VoiceProviderCredentials,
  type VoiceTtsConfig,
} from '@plumbus/voice/provider-kit';
import { createParser } from 'eventsource-parser';
import { MINIMAX_TTS_DESCRIPTOR, MINIMAX_TTS_MODELS } from './descriptor.js';
import { MINIMAX_VOICE_PRICING } from './pricing.js';

type MiniMaxStreamingMode = 'http' | 'websocket';

/** Default matches `@plumbus/voice` transport PCM (`pcm16-16k`) — runtime publishes raw PCM16. */
const DEFAULT_PCM_SAMPLE_RATE = 16_000;

const STREAMING_AUDIO_FORMATS = new Set(['mp3', 'pcm', 'flac', 'pcmu_raw', 'pcmu_wav', 'opus']);
const SAMPLE_RATES = new Set([8_000, 16_000, 22_050, 24_000, 32_000, 44_100]);
const BITRATES = new Set([32_000, 64_000, 128_000, 256_000]);
const CHANNELS = new Set([1, 2]);
const VOICE_MODIFY_SOUND_EFFECTS = new Set([
  'spacious_echo',
  'auditorium_echo',
  'lofi_telephone',
  'robotic',
]);

/** MiniMax API status_code sets (aligned with community minimax-speech-ts). */
const AUTH_STATUS_CODES = new Set([1004, 2042, 2049]);
const RATE_LIMIT_STATUS_CODES = new Set([1002, 1039, 1041, 2045, 2056]);
const VALIDATION_STATUS_CODES = new Set([
  1008, 1026, 1027, 1042, 1043, 1044, 2013, 2037, 2039, 2048, 20132,
]);

class MiniMaxTTSProvider implements TTSProvider {
  readonly capabilities = MINIMAX_TTS_DESCRIPTOR;
  #characters = 0;

  constructor(
    private readonly credentials: VoiceProviderCredentials,
    private readonly voiceSlice: VoiceTtsConfig,
  ) {}

  mapDeliveryTone(tone: DeliveryTone) {
    const model = this.voiceSlice.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo';
    return {
      model,
      voiceId: this.voiceSlice.voiceId,
      speed: mapPace(tone.pace),
      pitch: mapWarmth(tone.warmth),
      vol: mapEnergy(tone.energy),
      emotion: resolveMiniMaxEmotion(tone, model),
      languageBoost: resolveLanguageBoost(this.voiceSlice),
    };
  }

  async *synthesizeStream(text: string, params: unknown) {
    assertMiniMaxAudioOptions(this.voiceSlice.options);
    const fallbackChars = text.length;
    let reportedChars = fallbackChars;
    this.#characters += fallbackChars;
    const applyUsageCharacters = (usageChars: number) => {
      this.#characters += usageChars - reportedChars;
      reportedChars = usageChars;
    };

    const mode = resolveStreamingMode(this.voiceSlice.options);
    if (mode === 'websocket') {
      yield* this.synthesizeStreamWebSocket(text, params, applyUsageCharacters);
      return;
    }
    yield* this.synthesizeStreamHttp(text, params, applyUsageCharacters);
  }

  async *synthesizeStreamHttp(
    text: string,
    params: unknown,
    applyUsageCharacters: (usageChars: number) => void,
  ) {
    const request = resolveTtsFetch(this.credentials);
    const url = withMiniMaxGroupId(
      joinUrl(this.credentials.baseUrl ?? 'https://api.minimax.io', 'v1/t2a_v2'),
      this.credentials,
    );
    const mapped = isMiniMaxToneParams(params) ? params : this.mapDeliveryTone({});
    const response = await request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.apiKey ?? ''}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(buildT2aRequestBody(text, mapped, this.voiceSlice.options)),
    });

    await assertOkResponse(response, url);
    yield* decodeMiniMaxEventStream(response, { onUsageCharacters: applyUsageCharacters });
  }

  async *synthesizeStreamWebSocket(
    text: string,
    params: unknown,
    applyUsageCharacters: (usageChars: number) => void,
  ) {
    const mapped = isMiniMaxToneParams(params) ? params : this.mapDeliveryTone({});
    const baseUrl = this.credentials.baseUrl ?? 'https://api.minimax.io';
    const wsUrl = withMiniMaxGroupId(
      `${httpToWebSocketUrl(baseUrl).replace(/\/+$/, '')}/ws/v1/t2a_v2`,
      this.credentials,
    );
    const socket = resolveTtsWebSocketFactory(this.credentials)(wsUrl, {
      headers: { Authorization: `Bearer ${this.credentials.apiKey ?? ''}` },
    });

    await waitForSocketOpen(socket, 'MiniMax');
    const stream = createMiniMaxMessageStream(socket);
    let phase: 'connect' | 'start' | 'stream' = 'connect';

    try {
      for await (const message of stream) {
        assertMiniMaxBaseResp(message, 'TTS websocket');
        const event = typeof message.event === 'string' ? message.event : '';
        if (event === 'task_failed') {
          throwMiniMaxFailure('TTS websocket task failed', message);
        }

        if (phase === 'connect') {
          if (event !== 'connected_success') {
            continue;
          }
          socket.send(
            JSON.stringify({
              event: 'task_start',
              ...buildT2aTaskStartBody(mapped, this.voiceSlice.options),
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
          maybeApplyUsageCharacters(message, applyUsageCharacters);
          if (message.is_final === true) {
            return;
          }
        }
        if (event === 'task_finished' || event === 'task_finish') {
          maybeApplyUsageCharacters(message, applyUsageCharacters);
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
  pricing: MINIMAX_VOICE_PRICING,
  create(credentials, voiceSlice) {
    return new MiniMaxTTSProvider(credentials, voiceSlice);
  },
  async listVoices(credentials, modelId, context) {
    const baseUrl = credentials.baseUrl ?? 'https://api.minimax.io';
    const payload = await fetchCatalogJson(
      credentials,
      context.fetcher,
      withMiniMaxGroupId(`${baseUrl}/v1/get_voice`, credentials),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_type: 'all' }),
      },
    );
    const record =
      payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    assertMiniMaxBaseResp(record, 'get_voice');
    const systemVoice = Array.isArray(record.system_voice) ? record.system_voice : [];
    const voiceCloning = Array.isArray(record.voice_cloning) ? record.voice_cloning : [];
    const voiceGeneration = Array.isArray(record.voice_generation) ? record.voice_generation : [];
    return normalizeVoiceList([...systemVoice, ...voiceCloning, ...voiceGeneration], { modelId });
  },
};

function resolveStreamingMode(options: VoiceTtsConfig['options']): MiniMaxStreamingMode {
  const configured = options?.streamingMode;
  return configured === 'websocket' ? 'websocket' : 'http';
}

function assertMiniMaxAudioOptions(options: VoiceTtsConfig['options']): void {
  const format = resolveAudioFormat(options).toLowerCase();
  if (format === 'wav') {
    throw new PlumbusError(
      ErrorCode.Validation,
      'MiniMax streaming TTS does not support wav format; use pcm, mp3, or flac.',
    );
  }
  if (!STREAMING_AUDIO_FORMATS.has(format)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `MiniMax audio format "${format}" is not supported for streaming.`,
      { format, supported: [...STREAMING_AUDIO_FORMATS] },
    );
  }

  const sampleRate = resolveSampleRate(options, DEFAULT_PCM_SAMPLE_RATE);
  if (!SAMPLE_RATES.has(sampleRate)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `MiniMax sampleRate ${sampleRate} is not supported.`,
      { sampleRate, supported: [...SAMPLE_RATES] },
    );
  }

  const channel = resolveChannel(options, 1);
  if (!CHANNELS.has(channel)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `MiniMax channel must be 1 or 2, got ${channel}.`,
      {
        channel,
      },
    );
  }

  if (format === 'mp3') {
    const bitrate = resolveBitrate(options, 128_000);
    if (!BITRATES.has(bitrate)) {
      throw new PlumbusError(
        ErrorCode.Validation,
        `MiniMax mp3 bitrate ${bitrate} is not supported.`,
        { bitrate, supported: [...BITRATES] },
      );
    }
  }

  assertVoiceModifyOptions(options);
}

function assertVoiceModifyOptions(options: VoiceTtsConfig['options']): void {
  const raw = options?.voiceModify;
  if (raw === undefined) {
    return;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PlumbusError(ErrorCode.Validation, 'MiniMax options.voiceModify must be an object.');
  }
  const soundEffects = (raw as Record<string, unknown>).soundEffects;
  const soundEffectsSnake = (raw as Record<string, unknown>).sound_effects;
  const effect =
    typeof soundEffects === 'string'
      ? soundEffects
      : typeof soundEffectsSnake === 'string'
        ? soundEffectsSnake
        : undefined;
  if (effect !== undefined && !VOICE_MODIFY_SOUND_EFFECTS.has(effect)) {
    throw new PlumbusError(
      ErrorCode.Validation,
      `MiniMax voiceModify.soundEffects "${effect}" is not supported.`,
      { soundEffects: effect, supported: [...VOICE_MODIFY_SOUND_EFFECTS] },
    );
  }
}

function withMiniMaxGroupId(url: string, credentials: VoiceProviderCredentials): string {
  const groupId = resolveGroupId(credentials);
  if (!groupId) {
    return url;
  }
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}GroupId=${encodeURIComponent(groupId)}`;
}

function resolveGroupId(credentials: VoiceProviderCredentials): string | undefined {
  const configured = credentials.options?.groupId;
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined;
}

function buildT2aRequestBody(
  text: string,
  mapped: MiniMaxToneParams,
  options: VoiceTtsConfig['options'],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: mapped.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo',
    text,
    stream: true,
    output_format: 'hex',
    stream_options: {
      exclude_aggregated_audio: true,
    },
    language_boost: mapped.languageBoost,
    voice_setting: buildVoiceSetting(mapped, options),
    audio_setting: buildAudioSetting(options),
  };
  const voiceModify = buildVoiceModify(options);
  if (voiceModify) {
    body.voice_modify = voiceModify;
  }
  return body;
}

function buildT2aTaskStartBody(
  mapped: MiniMaxToneParams,
  options: VoiceTtsConfig['options'],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: mapped.model ?? MINIMAX_TTS_MODELS[0]?.id ?? 'speech-2.8-turbo',
    language_boost: mapped.languageBoost,
    voice_setting: buildVoiceSetting(mapped, options),
    audio_setting: buildAudioSetting(options),
  };
  const voiceModify = buildVoiceModify(options);
  if (voiceModify) {
    body.voice_modify = voiceModify;
  }
  return body;
}

function buildVoiceSetting(
  mapped: MiniMaxToneParams,
  options: VoiceTtsConfig['options'],
): Record<string, unknown> {
  const setting: Record<string, unknown> = {
    voice_id: mapped.voiceId,
    speed: mapped.speed,
    pitch: clampPitch(mapped.pitch),
    vol: mapped.vol,
    emotion: mapped.emotion,
  };
  const textNormalization = options?.textNormalization;
  if (typeof textNormalization === 'boolean') {
    setting.text_normalization = textNormalization;
  }
  return setting;
}

function buildVoiceModify(options: VoiceTtsConfig['options']): Record<string, unknown> | undefined {
  const raw = options?.voiceModify;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const modify: Record<string, unknown> = {};
  if (typeof record.pitch === 'number') {
    modify.pitch = record.pitch;
  }
  if (typeof record.intensity === 'number') {
    modify.intensity = record.intensity;
  }
  if (typeof record.timbre === 'number') {
    modify.timbre = record.timbre;
  }
  const soundEffects =
    typeof record.soundEffects === 'string'
      ? record.soundEffects
      : typeof record.sound_effects === 'string'
        ? record.sound_effects
        : undefined;
  if (soundEffects) {
    modify.sound_effects = soundEffects;
  }
  return Object.keys(modify).length > 0 ? modify : undefined;
}

function buildAudioSetting(options: VoiceTtsConfig['options']) {
  const format = resolveAudioFormat(options);
  const setting: {
    sample_rate: number;
    format: string;
    channel: number;
    bitrate?: number;
    force_cbr?: boolean;
  } = {
    sample_rate: resolveSampleRate(options, DEFAULT_PCM_SAMPLE_RATE),
    format,
    channel: resolveChannel(options, 1),
  };
  if (format === 'mp3') {
    setting.bitrate = resolveBitrate(options, 128_000);
  }
  const forceCbr = options?.forceCbr;
  if (typeof forceCbr === 'boolean') {
    setting.force_cbr = forceCbr;
  }
  return setting;
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
      return clampPitch(-2);
    case 'high':
      return clampPitch(2);
    default:
      return clampPitch(0);
  }
}

/** MiniMax pitch is an integer semitone offset in [-12, 12]. */
function clampPitch(value: number): number;
function clampPitch(value: number | undefined): number | undefined;
function clampPitch(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }
  return Math.max(-12, Math.min(12, Math.round(value)));
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

function resolveMiniMaxEmotion(tone: DeliveryTone, model: string | undefined): string | undefined {
  const explicit = normalizeEmotionLabel(tone.emotion, model);
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

function normalizeEmotionLabel(
  emotion: string | undefined,
  model: string | undefined,
): string | undefined {
  if (!emotion) {
    return undefined;
  }

  const candidate = emotion.toLowerCase().trim();
  if (!SUPPORTED_MINIMAX_EMOTIONS.has(candidate)) {
    return undefined;
  }
  if (SPEECH_26_ONLY_EMOTIONS.has(candidate) && !isSpeech26Model(model)) {
    return undefined;
  }
  return candidate;
}

function isSpeech26Model(model: string | undefined): boolean {
  return typeof model === 'string' && model.startsWith('speech-2.6');
}

interface MiniMaxStreamHooks {
  onUsageCharacters?: (usageChars: number) => void;
}

async function* decodeMiniMaxEventStream(
  response: Parameters<typeof readResponseChunks>[0],
  hooks: MiniMaxStreamHooks = {},
): AsyncIterable<Uint8Array> {
  const queue: string[] = [];
  let feedingDone = false;
  let failure: unknown;
  let wake: (() => void) | undefined;

  const parser = createParser({
    onEvent(event) {
      if (!event.data) {
        return;
      }
      queue.push(event.data);
      wake?.();
      wake = undefined;
    },
  });

  const feedPromise = (async () => {
    try {
      for await (const chunk of readResponseChunks(response)) {
        parser.feed(Buffer.from(chunk).toString('utf8'));
      }
    } catch (error) {
      failure = error;
    } finally {
      feedingDone = true;
      wake?.();
      wake = undefined;
    }
  })();

  try {
    while (!feedingDone || queue.length > 0) {
      if (queue.length === 0) {
        if (failure) {
          throw failure;
        }
        if (feedingDone) {
          break;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }

      const data = queue.shift();
      if (!data || data === '[DONE]') {
        continue;
      }
      const audio = decodeMiniMaxSseData(data, hooks);
      if (audio) {
        yield audio;
      }
    }
    if (failure) {
      throw failure;
    }
  } finally {
    await feedPromise;
  }
}

function resolveLanguageBoost(voiceSlice: VoiceTtsConfig): string | undefined {
  const configured = voiceSlice.options?.languageBoost;
  if (typeof configured === 'string' && configured.length > 0) {
    return configured;
  }
  return voiceSlice.locale?.startsWith('he') ? 'Hebrew' : undefined;
}

function decodeMiniMaxSseData(
  data: string,
  hooks: MiniMaxStreamHooks = {},
): Uint8Array | undefined {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  assertMiniMaxBaseResp(payload, 'TTS stream');

  const dataField =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : undefined;
  const status = typeof dataField?.status === 'number' ? dataField.status : undefined;

  // status 2 = synthesis completed (metadata / aggregated audio). Never play it.
  if (status === 2) {
    maybeApplyUsageCharacters(payload, hooks.onUsageCharacters);
    return undefined;
  }

  // Only status 1 chunks carry playable stream audio (matches MiniMax + community SDK).
  if (status !== 1) {
    return undefined;
  }

  const audio =
    typeof dataField?.audio === 'string' && dataField.audio.length > 0
      ? dataField.audio
      : undefined;
  return audio ? decodeHexAudio(audio) : undefined;
}

function assertMiniMaxBaseResp(payload: Record<string, unknown>, label: string): void {
  const baseResp = payload.base_resp;
  if (!baseResp || typeof baseResp !== 'object') {
    return;
  }
  const statusCode = (baseResp as Record<string, unknown>).status_code;
  if (typeof statusCode !== 'number' || statusCode === 0) {
    return;
  }
  throwMiniMaxFailure(label, payload);
}

function throwMiniMaxFailure(label: string, payload: Record<string, unknown>): never {
  const baseResp =
    payload.base_resp && typeof payload.base_resp === 'object'
      ? (payload.base_resp as Record<string, unknown>)
      : {};
  const statusCode = typeof baseResp.status_code === 'number' ? baseResp.status_code : undefined;
  const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : undefined;
  const { code, category } = mapMiniMaxStatusCode(statusCode);
  throw new PlumbusError(code, `MiniMax ${label} failed`, {
    statusCode,
    details: statusMsg,
    category,
    event: typeof payload.event === 'string' ? payload.event : undefined,
    traceId: typeof payload.trace_id === 'string' ? payload.trace_id : undefined,
  });
}

function mapMiniMaxStatusCode(statusCode: number | undefined): {
  code: ErrorCode;
  category: 'auth' | 'rateLimit' | 'validation' | 'api';
} {
  if (typeof statusCode === 'number' && AUTH_STATUS_CODES.has(statusCode)) {
    return { code: ErrorCode.Unauthorized, category: 'auth' };
  }
  if (typeof statusCode === 'number' && VALIDATION_STATUS_CODES.has(statusCode)) {
    return { code: ErrorCode.Validation, category: 'validation' };
  }
  if (typeof statusCode === 'number' && RATE_LIMIT_STATUS_CODES.has(statusCode)) {
    return { code: ErrorCode.Internal, category: 'rateLimit' };
  }
  return { code: ErrorCode.Internal, category: 'api' };
}

function maybeApplyUsageCharacters(
  payload: Record<string, unknown>,
  onUsageCharacters?: (usageChars: number) => void,
): void {
  if (!onUsageCharacters) {
    return;
  }
  const usage = getNestedNumber(payload, ['extra_info', 'usage_characters']);
  if (usage !== undefined) {
    onUsageCharacters(usage);
  }
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

function getNestedNumber(payload: Record<string, unknown>, path: string[]): number | undefined {
  let current: unknown = payload;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'number' && Number.isFinite(current) ? current : undefined;
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
  return typeof configured === 'string' && configured.length > 0 ? configured : 'pcm';
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
    const chunk = queue.shift();
    if (chunk) {
      yield chunk;
    }
  }
}

const SPEECH_26_ONLY_EMOTIONS = new Set(['fluent', 'whisper']);

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
