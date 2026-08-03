import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VoicePersonaOption, VoiceProviderCredentials } from '../../types/provider.js';
import type { VoiceCatalogFetch } from './provider-registration.js';

export function resolveCatalogFetch(fetcher?: VoiceCatalogFetch): VoiceCatalogFetch {
  if (fetcher) {
    return fetcher;
  }

  const globalFetch = (globalThis as { fetch?: VoiceCatalogFetch }).fetch;
  if (!globalFetch) {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Voice catalog fetch requires a fetch implementation in this runtime.',
    );
  }
  return globalFetch;
}

export async function fetchCatalogJson(
  credentials: VoiceProviderCredentials,
  fetcher: VoiceCatalogFetch | undefined,
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<unknown> {
  const request = resolveCatalogFetch(fetcher);
  const headers = {
    Accept: 'application/json',
    ...buildAuthorizationHeaders(credentials),
    ...init?.headers,
  };
  const response = await request(url, {
    method: init?.method ?? 'GET',
    headers,
    body: init?.body,
  });

  if (!response.ok) {
    throw new PlumbusError(
      ErrorCode.Internal,
      `Voice provider catalog request failed with status ${response.status}`,
      { url, status: response.status },
    );
  }

  return response.json();
}

export function buildAuthorizationHeaders(
  credentials: VoiceProviderCredentials,
): Record<string, string> {
  if (!credentials.apiKey) {
    return {};
  }
  return {
    Authorization: `Bearer ${credentials.apiKey}`,
    'xi-api-key': credentials.apiKey,
  };
}

export function normalizeVoiceList(
  payload: unknown,
  options?: { modelId?: string },
): VoicePersonaOption[] {
  const candidate =
    getArrayField(payload, 'voices') ??
    getArrayField(payload, 'items') ??
    getArrayField(payload, 'data') ??
    (Array.isArray(payload) ? payload : undefined);

  if (!candidate) {
    return [];
  }

  return candidate
    .map((value) => normalizeVoiceItem(value, options))
    .filter((value): value is VoicePersonaOption => value !== undefined);
}

function getArrayField(payload: unknown, field: string): unknown[] | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
}

function normalizeVoiceItem(
  payload: unknown,
  options?: { modelId?: string },
): VoicePersonaOption | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const record = payload as Record<string, unknown>;
  const id = pickString(record, ['id', 'voiceId', 'voice_id', 'name']);
  if (!id) {
    return undefined;
  }

  return {
    id,
    displayName:
      pickString(record, [
        'displayName',
        'display_name',
        'name',
        'title',
        'voiceName',
        'voice_name',
      ]) ?? id,
    locale: pickString(record, ['locale', 'language', 'languageCode', 'language_code']),
    previewUrl: pickString(record, ['previewUrl', 'preview_url', 'sampleUrl', 'sample_url']),
    modelId:
      options?.modelId ??
      pickString(record, ['modelId', 'model_id', 'model', 'modelName', 'supportedModel']),
    metadata: record,
  };
}

function pickString(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
