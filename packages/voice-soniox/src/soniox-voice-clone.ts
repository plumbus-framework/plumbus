import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  assertCloneSampleWithinLimit,
  type ClonedVoice,
  type ClonedVoiceModelStatus,
  type ClonedVoiceReadyState,
  type CreateClonedVoiceInput,
  type ListClonedVoicesInput,
  type ListClonedVoicesResult,
  type RecomputeClonedVoiceInput,
  type VoiceCloneCapabilities,
  type VoiceCloneProvider,
  type VoiceProviderCredentials,
  type WaitClonedVoiceReadyInput,
} from '@plumbus/voice/provider-kit';
import { SONIOX_TTS_MODELS } from './descriptor.js';

export const SONIOX_CLONE_CAPABILITIES: VoiceCloneCapabilities = {
  supported: true,
  readiness: 'async-per-model',
  supportsPersistedCreate: true,
  supportsInstantReference: false,
  maxSampleBytes: 10 * 1024 * 1024,
  maxSampleSeconds: 20,
  requiresGender: false,
  requiresLocale: false,
  supportsRecompute: true,
  supportsDelete: true,
  supportsList: true,
  supportsGet: true,
};

interface SonioxVoiceLike {
  id: string;
  name: string;
  filename?: string;
  created_at?: string;
  models?: Array<{
    model: string;
    status: string;
    error_type?: string | null;
    error_message?: string | null;
  }>;
  isReady?(model: string): boolean;
  delete?(): Promise<void>;
  recompute?(options?: { model?: string; signal?: AbortSignal }): Promise<SonioxVoiceLike>;
  toJSON?(): Record<string, unknown>;
}

interface SonioxVoicesApiLike {
  create(options: {
    name: string;
    file: Uint8Array | Buffer;
    filename?: string;
    signal?: AbortSignal;
  }): Promise<SonioxVoiceLike>;
  get(voice: string, signal?: AbortSignal): Promise<SonioxVoiceLike | null>;
  list(options?: {
    limit?: number;
    cursor?: string;
    signal?: AbortSignal;
  }): Promise<{ voices: SonioxVoiceLike[]; next_page_cursor?: string | null }>;
  delete(voice: string, signal?: AbortSignal): Promise<void>;
  recompute(
    voice: string,
    options?: { model?: string; signal?: AbortSignal },
  ): Promise<SonioxVoiceLike>;
}

interface SonioxClientLike {
  tts: {
    voices: SonioxVoicesApiLike;
  };
}

type SonioxClientFactory = (apiKey: string) => SonioxClientLike;

export class SonioxVoiceCloneProvider implements VoiceCloneProvider {
  readonly providerId = 'soniox';
  readonly capabilities = SONIOX_CLONE_CAPABILITIES;
  #usageEvents = 0;
  #clientFactory: SonioxClientFactory | undefined;

  constructor(private readonly credentials: VoiceProviderCredentials) {}

  async create(input: CreateClonedVoiceInput): Promise<ClonedVoice> {
    assertCloneSampleWithinLimit(input.audio, this.capabilities);
    const client = await this.#getClient();
    const voice = await client.tts.voices.create({
      name: input.name,
      file: Buffer.from(input.audio),
      filename: input.filename,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    this.#usageEvents += 1;
    return mapSonioxVoice(voice);
  }

  async get(id: string, signal?: AbortSignal): Promise<ClonedVoice | null> {
    const client = await this.#getClient();
    const voice = await client.tts.voices.get(id, signal);
    return voice ? mapSonioxVoice(voice) : null;
  }

  async list(input?: ListClonedVoicesInput): Promise<ListClonedVoicesResult> {
    const client = await this.#getClient();
    const result = await client.tts.voices.list({
      ...(input?.limit !== undefined ? { limit: input.limit } : {}),
      ...(input?.cursor ? { cursor: input.cursor } : {}),
      ...(input?.signal ? { signal: input.signal } : {}),
    });
    return {
      voices: (result.voices ?? []).map(mapSonioxVoice),
      ...(result.next_page_cursor ? { nextCursor: result.next_page_cursor } : {}),
    };
  }

  async delete(id: string, signal?: AbortSignal): Promise<void> {
    const client = await this.#getClient();
    await client.tts.voices.delete(id, signal);
    this.#usageEvents += 1;
  }

  async recompute(id: string, input?: RecomputeClonedVoiceInput): Promise<ClonedVoice> {
    const client = await this.#getClient();
    const voice = await client.tts.voices.recompute(id, {
      ...(input?.model ? { model: input.model } : {}),
      ...(input?.signal ? { signal: input.signal } : {}),
    });
    return mapSonioxVoice(voice);
  }

  async waitUntilReady(id: string, input?: WaitClonedVoiceReadyInput): Promise<ClonedVoice> {
    const model = input?.model ?? SONIOX_TTS_MODELS[0]?.id ?? 'tts-rt-v1';
    const pollIntervalMs = input?.pollIntervalMs ?? 2000;
    const timeoutMs = input?.timeoutMs ?? 120_000;
    const started = Date.now();
    const client = await this.#getClient();

    while (Date.now() - started <= timeoutMs) {
      if (input?.signal?.aborted) {
        throw new PlumbusError(ErrorCode.Validation, 'Soniox waitUntilReady aborted');
      }
      const voice = await client.tts.voices.get(id, input?.signal);
      if (!voice) {
        throw new PlumbusError(ErrorCode.NotFound, `Soniox voice "${id}" not found`);
      }
      const mapped = mapSonioxVoice(voice);
      const ready =
        typeof voice.isReady === 'function'
          ? voice.isReady(model)
          : mapped.models?.some((entry) => entry.model === model && entry.status === 'ready');
      if (ready) {
        return { ...mapped, status: 'ready' };
      }
      const failed = mapped.models?.find(
        (entry) => entry.model === model && entry.status === 'failed',
      );
      if (failed) {
        throw new PlumbusError(
          ErrorCode.Internal,
          `Soniox voice "${id}" failed for model "${model}": ${failed.errorMessage ?? 'unknown'}`,
        );
      }
      await sleep(pollIntervalMs);
    }
    throw new PlumbusError(
      ErrorCode.Internal,
      `Soniox voice "${id}" was not ready for model "${model}" within ${timeoutMs}ms`,
    );
  }

  usage() {
    if (this.#usageEvents === 0) {
      return [];
    }
    return [
      {
        provider: this.providerId,
        kind: 'clone' as const,
        quantity: this.#usageEvents,
        unit: 'events' as const,
        model: 'soniox-clone',
      },
    ];
  }

  async #getClient(): Promise<SonioxClientLike> {
    const apiKey = this.credentials.apiKey;
    if (!apiKey) {
      throw new PlumbusError(ErrorCode.Validation, 'Soniox clone provider requires an apiKey');
    }
    if (!this.#clientFactory) {
      this.#clientFactory = await resolveSonioxCloneClientFactory(this.credentials);
    }
    return this.#clientFactory(apiKey);
  }
}

function mapSonioxVoice(voice: SonioxVoiceLike): ClonedVoice {
  const models: ClonedVoiceModelStatus[] | undefined = voice.models?.map((entry) => ({
    model: entry.model,
    status: normalizeStatus(entry.status),
    ...(entry.error_type ? { errorType: entry.error_type } : {}),
    ...(entry.error_message ? { errorMessage: entry.error_message } : {}),
  }));
  const overall = models?.some((entry) => entry.status === 'ready')
    ? 'ready'
    : models?.some((entry) => entry.status === 'failed')
      ? 'failed'
      : models?.some((entry) => entry.status === 'processing')
        ? 'processing'
        : 'not_computed';
  return {
    id: voice.id,
    providerId: 'soniox',
    displayName: voice.name,
    createdAt: voice.created_at,
    status: overall,
    ...(models ? { models } : {}),
  };
}

function normalizeStatus(status: string): ClonedVoiceReadyState {
  if (
    status === 'ready' ||
    status === 'processing' ||
    status === 'failed' ||
    status === 'not_computed'
  ) {
    return status;
  }
  return 'processing';
}

async function resolveSonioxCloneClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<SonioxClientFactory> {
  const options = credentials.options as Record<string, unknown> | undefined;
  const injected = options?.sonioxClientFactory ?? options?.sonioxTtsClientFactory;
  if (typeof injected === 'function') {
    return (apiKey: string) => {
      const client = (injected as (apiKey: string) => unknown)(apiKey);
      if (
        client &&
        typeof client === 'object' &&
        'tts' in client &&
        (client as SonioxClientLike).tts?.voices
      ) {
        return client as SonioxClientLike;
      }
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Injected Soniox factory must return a client with tts.voices',
      );
    };
  }

  const imported = (await import('@soniox/node')) as {
    SonioxNodeClient?: new (options: { api_key: string }) => SonioxClientLike;
    default?: {
      SonioxNodeClient?: new (options: { api_key: string }) => SonioxClientLike;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
