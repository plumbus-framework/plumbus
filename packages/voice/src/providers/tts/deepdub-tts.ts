import { randomUUID } from 'node:crypto';
import type { TTSProviderCatalogEntry } from '../../types/provider.js';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { DeliveryTone, VoiceTtsConfig } from '../../types/voice.js';
import { DEEPDUB_TTS_MODELS } from '../../catalog/static-models.js';
import { fetchCatalogJson, normalizeVoiceList } from '../base/catalog-http.js';
import type { TTSProviderRegistration } from '../base/provider-registration.js';
import type { TTSProvider } from '../base/tts-provider.js';
import type { TTSWebSocket } from './wire.js';
import {
  decodeBase64Audio,
  httpToWebSocketUrl,
  resolveTtsWebSocketFactory,
  socketMessageToString,
} from './wire.js';

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

interface ActiveGeneration {
  generationId: string;
  queue: Uint8Array[];
  closed: boolean;
  failure?: Error;
  notify?: () => void;
  abortRequested: boolean;
}

class DeepdubConnection {
  readonly #socket: TTSWebSocket;
  readonly #generations = new Map<string, ActiveGeneration>();
  #openPromise: Promise<void> | undefined;
  #closed = false;

  constructor(socket: TTSWebSocket) {
    this.#socket = socket;
    socket.on('message', (data) => {
      const message = JSON.parse(socketMessageToString(data)) as Record<string, unknown>;
      let generationId =
        typeof message.generationId === 'string'
          ? message.generationId
          : typeof message.generation_id === 'string'
            ? message.generation_id
            : undefined;
      if (!generationId && this.#generations.size === 1) {
        generationId = [...this.#generations.keys()][0];
      }
      const generation = generationId ? this.#generations.get(generationId) : undefined;
      if (!generation) return;

      if (message.error) {
        generation.failure = new Error(
          typeof message.error === 'string' ? message.error : 'Deepdub websocket request failed',
        );
        generation.closed = true;
        generation.notify?.();
        return;
      }

      const chunk = typeof message.data === 'string' ? decodeBase64Audio(message.data) : undefined;
      if (chunk && chunk.length > 0) {
        generation.queue.push(chunk);
        generation.notify?.();
      }
      if (message.isFinished === true) {
        generation.closed = true;
        generation.notify?.();
      }
    });
    socket.on('close', () => {
      this.#closed = true;
      for (const generation of this.#generations.values()) {
        generation.closed = true;
        generation.notify?.();
      }
    });
    socket.on('error', (error) => {
      for (const generation of this.#generations.values()) {
        generation.failure = error;
        generation.closed = true;
        generation.notify?.();
      }
    });
  }

  async ensureOpen(label: string): Promise<void> {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = waitForSocketOpen(this.#socket, label);
    return this.#openPromise;
  }

  startGeneration(generationId: string): ActiveGeneration {
    const generation: ActiveGeneration = {
      generationId,
      queue: [],
      closed: false,
      abortRequested: false,
    };
    this.#generations.set(generationId, generation);
    return generation;
  }

  send(payload: Record<string, unknown>): void {
    this.#socket.send(JSON.stringify(payload));
  }

  abortGeneration(generationId: string): void {
    const generation = this.#generations.get(generationId);
    if (!generation) return;
    generation.abortRequested = true;
    generation.closed = true;
    generation.notify?.();
    this.#generations.delete(generationId);
    this.send({ action: 'abort', generationId, realtime: true });
  }

  abortAll(): void {
    for (const generationId of [...this.#generations.keys()]) {
      this.abortGeneration(generationId);
    }
  }

  close(): void {
    this.abortAll();
    this.#socket.close();
    this.#closed = true;
  }

  get closed(): boolean {
    return this.#closed;
  }
}

class DeepdubTTSProvider implements TTSProvider {
  readonly capabilities = DEEPDUB_TTS_DESCRIPTOR;
  #characters = 0;
  #connection: DeepdubConnection | undefined;

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
    };
  }

  async *synthesizeStream(text: string, params: unknown, signal?: AbortSignal) {
    this.#characters += text.length;
    const mapped = isDeepdubToneParams(params) ? params : this.mapDeliveryTone({});
    const connection = await this.#getConnection();
    const generationId = randomUUID();
    const generation = connection.startGeneration(generationId);

    const onAbort = () => {
      connection.abortGeneration(generationId);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      connection.send({
        action: 'text-to-speech',
        generationId,
        realtime: true,
        model: mapped.model ?? DEEPDUB_TTS_MODELS[0]?.id ?? 'dd-etts-3.0',
        targetText: text,
        locale: mapped.locale ?? this.voiceSlice.locale ?? 'en-US',
        voicePromptId: mapped.voiceId,
        format: resolveDeepdubFormat(this.voiceSlice.options),
        sampleRate: resolveSampleRate(this.voiceSlice.options, 16_000),
        tempo: mapped.tempo,
        variance: mapped.variance,
        temperature: mapped.temperature,
        promptBoost: mapped.promptBoost,
      });

      while (!generation.closed || generation.queue.length > 0) {
        if (signal?.aborted || generation.abortRequested) {
          connection.abortGeneration(generationId);
          return;
        }
        if (generation.failure) {
          throw generation.failure;
        }
        if (generation.queue.length > 0) {
          yield generation.queue.shift()!;
          continue;
        }
        if (generation.closed) {
          break;
        }
        await new Promise<void>((resolve) => {
          generation.notify = resolve;
        });
      }

      if (generation.failure) {
        throw generation.failure;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  abortGeneration(generationId: string): void {
    this.#connection?.abortGeneration(generationId);
  }

  abortAll(): void {
    this.#connection?.abortAll();
  }

  async flush(): Promise<void> {
    this.#connection?.close();
    this.#connection = undefined;
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

  async #getConnection(): Promise<DeepdubConnection> {
    if (this.#connection && !this.#connection.closed) {
      return this.#connection;
    }

    const url = resolveDeepdubWebSocketUrl(this.credentials.baseUrl);
    const socketFactory = resolveTtsWebSocketFactory(this.credentials);
    const socket = socketFactory(url, {
      headers: { 'x-api-key': this.credentials.apiKey ?? '' },
    });
    const connection = new DeepdubConnection(socket);
    await connection.ensureOpen('Deepdub');
    this.#connection = connection;
    return connection;
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
}

function isDeepdubToneParams(value: unknown): value is DeepdubToneParams {
  return typeof value === 'object' && value !== null;
}

function resolveDeepdubWebSocketUrl(baseUrl: string | undefined): string {
  if (!baseUrl) {
    return 'wss://wsapi.deepdub.ai/open';
  }

  const normalized = httpToWebSocketUrl(baseUrl);
  return normalized.endsWith('/open') ? normalized : `${normalized.replace(/\/+$/, '')}/open`;
}

function resolveDeepdubFormat(options: VoiceTtsConfig['options']): string {
  const configured = options?.format;
  return typeof configured === 'string' && configured.length > 0 ? configured : 'wav';
}

function resolveSampleRate(options: VoiceTtsConfig['options'], fallback: number): number {
  const configured = options?.sampleRate;
  return typeof configured === 'number' ? configured : fallback;
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
