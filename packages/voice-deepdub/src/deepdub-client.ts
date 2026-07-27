import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';

export const DEEPDUB_REST_BASE_URL = 'https://restapi.deepdub.ai/api/v1';

export interface DeepdubSdkClient {
  connect(): Promise<unknown>;
  generateToBuffer(text: string, params?: Record<string, unknown>): Promise<unknown>;
  disconnect?(): void;
  addVoice?(params: Record<string, unknown>): Promise<unknown>;
  listVoices?(limit?: number): Promise<unknown>;
}

export type DeepdubClientFactory = (
  apiKey: string,
  options: { protocol: 'websocket' | 'http'; baseUrl?: string },
) => DeepdubSdkClient;

export function resolveDeepdubRestBaseUrl(credentials: VoiceProviderCredentials): string {
  return credentials.baseUrl ?? DEEPDUB_REST_BASE_URL;
}

export async function resolveDeepdubClientFactory(
  credentials: VoiceProviderCredentials,
): Promise<DeepdubClientFactory> {
  const options = credentials.options as Record<string, unknown> | undefined;
  const injected = options?.deepdubClientFactory;
  if (typeof injected === 'function') {
    return injected as DeepdubClientFactory;
  }
  const injectedHttp = options?.deepdubHttpClientFactory;
  if (typeof injectedHttp === 'function') {
    // Prefer protocol-aware factory when only HTTP factory is injected.
    return (apiKey, opts) => {
      if (opts.protocol === 'http') {
        return (injectedHttp as DeepdubClientFactory)(apiKey, opts);
      }
      throw new PlumbusError(
        ErrorCode.DependencyViolation,
        'Injected deepdubHttpClientFactory only supports protocol "http"',
      );
    };
  }

  const imported = (await import('@deepdub/node')) as unknown as {
    DeepdubClient?: new (
      apiKey: string,
      options: { protocol: 'websocket' | 'http'; baseUrl?: string },
    ) => DeepdubSdkClient;
    default?: {
      DeepdubClient?: new (
        apiKey: string,
        options: { protocol: 'websocket' | 'http'; baseUrl?: string },
      ) => DeepdubSdkClient;
    };
  };
  const ClientCtor = imported.DeepdubClient ?? imported.default?.DeepdubClient;
  if (typeof ClientCtor !== 'function') {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Unable to load DeepdubClient from @deepdub/node',
    );
  }
  return (apiKey, clientOptions) => new ClientCtor(apiKey, clientOptions);
}

export async function deepdubRestJson(
  credentials: VoiceProviderCredentials,
  path: string,
  init?: { method?: string; body?: string; fetcher?: typeof fetch },
): Promise<{ ok: boolean; status: number; json: unknown }> {
  const apiKey = credentials.apiKey;
  if (!apiKey) {
    throw new PlumbusError(ErrorCode.Validation, 'Deepdub requires an apiKey');
  }
  const baseUrl = resolveDeepdubRestBaseUrl(credentials).replace(/\/$/, '');
  const fetcher =
    (credentials.options as Record<string, unknown> | undefined)?.fetch ??
    init?.fetcher ??
    globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new PlumbusError(ErrorCode.DependencyViolation, 'Deepdub REST requires fetch');
  }
  const response = await (fetcher as typeof fetch)(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      'x-api-key': apiKey,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body,
  });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  return { ok: response.ok, status: response.status, json };
}

export function extractDeepdubVoicePromptId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.voice_prompt_id === 'string' && record.voice_prompt_id.length > 0) {
    return record.voice_prompt_id;
  }
  const nested = record.response;
  if (nested && typeof nested === 'object') {
    const nestedRecord = nested as Record<string, unknown>;
    if (
      typeof nestedRecord.voice_prompt_id === 'string' &&
      nestedRecord.voice_prompt_id.length > 0
    ) {
      return nestedRecord.voice_prompt_id;
    }
  }
  if (typeof record.id === 'string' && record.id.length > 0) {
    return record.id;
  }
  return undefined;
}

export function mapDeepdubGender(gender: 'male' | 'female'): string {
  return gender.toUpperCase();
}
