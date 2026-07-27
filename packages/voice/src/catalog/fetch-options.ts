import { createHash } from 'node:crypto';
import { ErrorCode, PlumbusError } from '@plumbus/core';
import type {
  VoiceCatalogSource,
  VoiceModelOption,
  VoicePersonaOption,
  VoiceProviderOptionsResult,
  VoiceProvidersConfig,
} from '../types/provider.js';
import type {
  STTProviderRegistration,
  TTSProviderRegistration,
  VoiceCatalogFetch,
} from '../providers/base/provider-registration.js';
import type { VoiceProviderRegistry } from '../providers/registry.js';
import { createProviderRegistry } from '../providers/registry.js';

const providerOptionsCache = new Map<
  string,
  {
    expiresAt: number;
    value: VoiceProviderOptionsResult;
  }
>();

export interface FetchVoiceProviderOptionsArgs {
  kind: 'stt' | 'tts';
  providerId: string;
  providers: VoiceProvidersConfig;
  registry?: VoiceProviderRegistry;
  fetcher?: VoiceCatalogFetch;
  ttlMs?: number;
  modelId?: string;
}

export async function fetchVoiceProviderOptions(
  args: FetchVoiceProviderOptionsArgs,
): Promise<VoiceProviderOptionsResult> {
  const ttlMs = args.ttlMs ?? 10 * 60 * 1_000;
  const registry = args.registry ?? createProviderRegistry();
  const credentials = args.providers.providers[args.providerId] ?? {};
  const cacheKey = createCacheKey(args, credentials);
  const cached = providerOptionsCache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return {
      ...cached.value,
      cached: true,
    };
  }

  const result =
    args.kind === 'stt'
      ? await fetchSttProviderOptions(args, registry.stt.get(args.providerId), credentials)
      : await fetchTtsProviderOptions(args, registry.tts.get(args.providerId), credentials);

  providerOptionsCache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    value: result,
  });

  return result;
}

function createCacheKey(
  args: FetchVoiceProviderOptionsArgs,
  credentials: VoiceProvidersConfig['providers'][string],
): string {
  return [
    args.kind,
    args.providerId,
    args.modelId ?? '',
    credentials.baseUrl ?? '',
    hashCredential(credentials.apiKey),
  ].join(':');
}

async function fetchSttProviderOptions(
  args: FetchVoiceProviderOptionsArgs,
  registration: STTProviderRegistration | undefined,
  credentials: VoiceProvidersConfig['providers'][string],
): Promise<VoiceProviderOptionsResult> {
  if (!registration) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice stt provider "${args.providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
      {
        providerId: args.providerId,
        kind: args.kind,
      },
    );
  }

  const fallback = {
    providerId: args.providerId,
    kind: 'stt' as const,
    models: [...registration.descriptor.knownModels],
    voices: [] satisfies VoicePersonaOption[],
    source: 'static' as VoiceCatalogSource,
    partial: false,
  };

  if (!registration.listModels || !credentials.apiKey) {
    return fallback;
  }

  try {
    const models = await registration.listModels(credentials, { fetcher: args.fetcher });
    return {
      ...fallback,
      models: cloneModels(models),
      source: 'live-api',
    };
  } catch (error) {
    return {
      ...fallback,
      partial: true,
      error: error instanceof Error ? error.message : 'Unknown STT catalog error',
    };
  }
}

async function fetchTtsProviderOptions(
  args: FetchVoiceProviderOptionsArgs,
  registration: TTSProviderRegistration | undefined,
  credentials: VoiceProvidersConfig['providers'][string],
): Promise<VoiceProviderOptionsResult> {
  if (!registration) {
    throw new PlumbusError(
      ErrorCode.NotFound,
      `Voice tts provider "${args.providerId}" is not registered — pass its *_REGISTRATION to createProviderRegistry()`,
      {
        providerId: args.providerId,
        kind: args.kind,
      },
    );
  }

  const fallback = {
    providerId: args.providerId,
    kind: 'tts' as const,
    models: [...registration.descriptor.knownModels],
    voices: [...(registration.descriptor.knownVoices ?? [])],
    source: registration.descriptor.voicesSource ?? 'static',
    partial: false,
  };

  if (!credentials.apiKey) {
    return {
      ...fallback,
      source:
        fallback.voices.length > 0 ? 'static' : (registration.descriptor.voicesSource ?? 'static'),
    };
  }

  try {
    const [models, voices] = await Promise.all([
      registration.listModels
        ? registration.listModels(credentials, { fetcher: args.fetcher })
        : Promise.resolve(fallback.models),
      registration.listVoices
        ? registration.listVoices(credentials, args.modelId, { fetcher: args.fetcher })
        : Promise.resolve(fallback.voices),
    ]);

    const source: VoiceCatalogSource =
      registration.listModels || registration.listVoices ? 'live-api' : 'static';

    return {
      providerId: args.providerId,
      kind: 'tts',
      models: cloneModels(models),
      voices: cloneVoices(voices),
      source,
      partial: false,
    };
  } catch (error) {
    return {
      ...fallback,
      partial: true,
      error: error instanceof Error ? error.message : 'Unknown TTS catalog error',
    };
  }
}

function hashCredential(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return createHash('sha1').update(value).digest('hex');
}

function cloneModels(models: readonly VoiceModelOption[]): VoiceModelOption[] {
  return models.map((model) => ({ ...model }));
}

function cloneVoices(voices: readonly VoicePersonaOption[]): VoicePersonaOption[] {
  return voices.map((voice) => ({
    ...voice,
    metadata: voice.metadata ? { ...voice.metadata } : undefined,
  }));
}
