import { ErrorCode, PlumbusError } from '@plumbus/core';
import {
  assertCloneSampleWithinLimit,
  type ClonedVoice,
  type CreateClonedVoiceInput,
  type ListClonedVoicesInput,
  type ListClonedVoicesResult,
  type SynthesizeWithVoiceReferenceInput,
  type VoiceCloneCapabilities,
  type VoiceCloneProvider,
  type VoiceProviderCredentials,
  type WaitClonedVoiceReadyInput,
} from '@plumbus/voice/provider-kit';
import {
  deepdubRestJson,
  extractDeepdubVoicePromptId,
  mapDeepdubGender,
  resolveDeepdubClientFactory,
  resolveDeepdubRestBaseUrl,
} from './deepdub-client.js';
import { DEEPDUB_TTS_MODELS } from './descriptor.js';

export const DEEPDUB_CLONE_CAPABILITIES: VoiceCloneCapabilities = {
  supported: true,
  readiness: 'immediate',
  supportsPersistedCreate: true,
  supportsInstantReference: true,
  maxSampleBytes: 20 * 1024 * 1024,
  requiresGender: true,
  requiresLocale: true,
  supportsRecompute: false,
  supportsDelete: true,
  supportsList: true,
  supportsGet: true,
};

export class DeepdubVoiceCloneProvider implements VoiceCloneProvider {
  readonly providerId = 'deepdub';
  readonly capabilities = DEEPDUB_CLONE_CAPABILITIES;
  #usageEvents = 0;

  constructor(private readonly credentials: VoiceProviderCredentials) {}

  async create(input: CreateClonedVoiceInput): Promise<ClonedVoice> {
    assertCloneSampleWithinLimit(input.audio, this.capabilities);
    if (!input.gender) {
      throw new PlumbusError(ErrorCode.Validation, 'Deepdub clone create requires gender');
    }
    if (!input.locale) {
      throw new PlumbusError(ErrorCode.Validation, 'Deepdub clone create requires locale');
    }
    const factory = await resolveDeepdubClientFactory(this.credentials);
    const client = factory(this.credentials.apiKey ?? '', {
      protocol: 'http',
      baseUrl: resolveDeepdubRestBaseUrl(this.credentials),
    });
    if (typeof client.addVoice !== 'function') {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'DeepdubClient.addVoice is unavailable',
      );
    }
    const response = await client.addVoice({
      data: Buffer.from(input.audio),
      name: input.name,
      gender: mapDeepdubGender(input.gender),
      locale: input.locale,
      filename: input.filename,
      ...(input.speakingStyle ? { speakingStyle: input.speakingStyle } : {}),
      ...(input.age !== undefined ? { age: input.age } : {}),
      ...(input.text ? { text: input.text } : {}),
    });
    const id = extractDeepdubVoicePromptId(response);
    if (!id) {
      throw new PlumbusError(
        ErrorCode.Internal,
        'Deepdub addVoice did not return a voice_prompt_id',
      );
    }
    this.#usageEvents += 1;
    return {
      id,
      providerId: this.providerId,
      displayName: input.name,
      locale: input.locale,
      status: 'ready',
    };
  }

  async get(id: string, _signal?: AbortSignal): Promise<ClonedVoice | null> {
    const result = await deepdubRestJson(this.credentials, `/voice/${encodeURIComponent(id)}`);
    if (result.status === 404) {
      return null;
    }
    if (!result.ok) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `Deepdub get voice failed with status ${result.status}`,
        { status: result.status },
      );
    }
    return mapDeepdubVoicePayload(result.json, id);
  }

  async list(input?: ListClonedVoicesInput): Promise<ListClonedVoicesResult> {
    const factory = await resolveDeepdubClientFactory(this.credentials);
    const client = factory(this.credentials.apiKey ?? '', {
      protocol: 'http',
      baseUrl: resolveDeepdubRestBaseUrl(this.credentials),
    });
    if (typeof client.listVoices !== 'function') {
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'DeepdubClient.listVoices is unavailable',
      );
    }
    const payload = await client.listVoices(input?.limit);
    const prompts = extractVoicePrompts(payload);
    return {
      voices: prompts.map((prompt) => mapDeepdubVoicePayload(prompt)).filter(isClonedVoice),
    };
  }

  async delete(id: string, _signal?: AbortSignal): Promise<void> {
    const result = await deepdubRestJson(this.credentials, `/voice/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (result.status === 404) {
      return;
    }
    if (!result.ok) {
      throw new PlumbusError(
        ErrorCode.Internal,
        `Deepdub delete voice failed with status ${result.status}`,
        { status: result.status },
      );
    }
    this.#usageEvents += 1;
  }

  async waitUntilReady(id: string, input?: WaitClonedVoiceReadyInput): Promise<ClonedVoice> {
    const pollIntervalMs = input?.pollIntervalMs ?? 200;
    const timeoutMs = input?.timeoutMs ?? 10_000;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      if (input?.signal?.aborted) {
        throw new PlumbusError(ErrorCode.Validation, 'Deepdub waitUntilReady aborted');
      }
      const voice = await this.get(id, input?.signal);
      if (voice) {
        return { ...voice, status: 'ready' };
      }
      await sleep(pollIntervalMs);
    }
    throw new PlumbusError(
      ErrorCode.Internal,
      `Deepdub voice "${id}" was not ready within ${timeoutMs}ms`,
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
        model: 'deepdub-clone',
      },
    ];
  }
}

export async function deepdubSynthesizeWithVoiceReference(
  credentials: VoiceProviderCredentials,
  input: SynthesizeWithVoiceReferenceInput,
): Promise<Uint8Array> {
  assertCloneSampleWithinLimit(input.audio, DEEPDUB_CLONE_CAPABILITIES);
  const factory = await resolveDeepdubClientFactory(credentials);
  const client = factory(credentials.apiKey ?? '', {
    protocol: 'http',
    baseUrl: resolveDeepdubRestBaseUrl(credentials),
  });
  const buffer = await client.generateToBuffer(input.text, {
    voiceReference: Buffer.from(input.audio),
    locale: input.locale ?? 'en-US',
    model: input.model ?? DEEPDUB_TTS_MODELS[0]?.id ?? 'dd-etts-3.2',
    ...(input.sampleRate !== undefined ? { sampleRate: input.sampleRate } : {}),
  });
  if (Buffer.isBuffer(buffer)) {
    return new Uint8Array(buffer);
  }
  if (buffer instanceof Uint8Array) {
    return buffer;
  }
  throw new PlumbusError(
    ErrorCode.Internal,
    'Deepdub voiceReference synthesis did not return a Buffer',
  );
}

function extractVoicePrompts(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') {
    return [];
  }
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.voicePrompts)) {
    return record.voicePrompts;
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function mapDeepdubVoicePayload(payload: unknown, fallbackId?: string): ClonedVoice | null {
  if (!payload || typeof payload !== 'object') {
    if (fallbackId) {
      return {
        id: fallbackId,
        providerId: 'deepdub',
        displayName: fallbackId,
        status: 'ready',
      };
    }
    return null;
  }
  const record = payload as Record<string, unknown>;
  const id =
    extractDeepdubVoicePromptId(record) ?? (typeof record.id === 'string' ? record.id : fallbackId);
  if (!id) {
    return null;
  }
  const displayName =
    (typeof record.name === 'string' && record.name) ||
    (typeof record.title === 'string' && record.title) ||
    id;
  return {
    id,
    providerId: 'deepdub',
    displayName,
    locale: typeof record.locale === 'string' ? record.locale : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : undefined,
    status: 'ready',
  };
}

function isClonedVoice(value: ClonedVoice | null): value is ClonedVoice {
  return value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
