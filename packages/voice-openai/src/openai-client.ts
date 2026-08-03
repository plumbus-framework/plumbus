import { ErrorCode, PlumbusError } from '@plumbus/core';
import type { VoiceProviderCredentials } from '@plumbus/voice/provider-kit';
import OpenAI from 'openai';

/** Default OpenAI REST base (SDK also defaults here when `baseURL` is omitted). */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Minimal structural surface of the official `openai` SDK used by Whisper STT + TTS.
 * Inject `credentials.options.openaiClientFactory` in tests.
 */
export interface OpenAIAudioClientLike {
  audio: {
    transcriptions: {
      create(body: Record<string, unknown>): Promise<{ text?: string | null }>;
    };
    speech: {
      create(body: Record<string, unknown>): Promise<Response>;
    };
  };
}

export type OpenAIClientFactory = (options: {
  apiKey: string;
  /** OpenAI-compatible API root, e.g. `https://api.openai.com/v1` or a local sidecar. */
  baseURL?: string;
}) => OpenAIAudioClientLike;

/**
 * Normalize credential `baseUrl` for the SDK `baseURL` option.
 * Returns `undefined` when unset so the SDK uses its built-in default.
 */
export function resolveOpenAIBaseURL(credentials: VoiceProviderCredentials): string | undefined {
  const raw = credentials.baseUrl?.trim();
  if (!raw) {
    return undefined;
  }
  return raw.replace(/\/+$/, '');
}

export function resolveOpenAIClientFactory(
  credentials: VoiceProviderCredentials,
): OpenAIClientFactory {
  const injected = (credentials.options as Record<string, unknown> | undefined)
    ?.openaiClientFactory;
  if (typeof injected === 'function') {
    return injected as OpenAIClientFactory;
  }

  return ({ apiKey, baseURL }) => {
    if (!apiKey) {
      throw new PlumbusError(ErrorCode.Validation, 'OpenAI client requires an apiKey');
    }
    return new OpenAI({
      apiKey,
      ...(baseURL ? { baseURL } : {}),
    }) as unknown as OpenAIAudioClientLike;
  };
}
