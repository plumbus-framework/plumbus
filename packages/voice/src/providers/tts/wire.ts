import { ErrorCode, PlumbusError } from '@plumbus/core';
import WebSocket from 'ws';
import type { VoiceProviderCredentials } from '../../types/provider.js';

export interface TTSFetchResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: TTSResponseBody;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface TTSReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  releaseLock?(): void;
}

export interface TTSResponseBody {
  getReader?(): TTSReader;
  [Symbol.asyncIterator]?(): AsyncIterator<Uint8Array>;
}

export type TTSFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<TTSFetchResponse>;

export interface TTSWebSocket {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: WebSocket.RawData) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: () => void): void;
}

export type TTSWebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => TTSWebSocket;

type TtsWireOptions = {
  fetch?: TTSFetch;
  webSocketFactory?: TTSWebSocketFactory;
};

export function resolveTtsFetch(credentials: VoiceProviderCredentials): TTSFetch {
  const injectedFetch = (credentials.options as TtsWireOptions | undefined)?.fetch;
  if (injectedFetch) {
    return injectedFetch;
  }

  const globalFetch = (globalThis as { fetch?: TTSFetch }).fetch;
  if (!globalFetch) {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'Voice TTS fetch requires a fetch implementation in this runtime.',
    );
  }

  return globalFetch;
}

export function resolveTtsWebSocketFactory(
  credentials: VoiceProviderCredentials,
): TTSWebSocketFactory {
  const injectedFactory = (credentials.options as TtsWireOptions | undefined)?.webSocketFactory;
  if (injectedFactory) {
    return injectedFactory;
  }

  return (url, options) => new WebSocket(url, { headers: options?.headers });
}

export function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedPath = path.replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedPath}`;
}

export function httpToWebSocketUrl(url: string): string {
  if (url.startsWith('wss://') || url.startsWith('ws://')) {
    return url;
  }
  if (url.startsWith('https://')) {
    return `wss://${url.slice('https://'.length)}`;
  }
  if (url.startsWith('http://')) {
    return `ws://${url.slice('http://'.length)}`;
  }
  return url;
}

export async function* readResponseChunks(
  response: Pick<TTSFetchResponse, 'body'>,
): AsyncIterable<Uint8Array> {
  if (!response.body) {
    return;
  }

  const asyncIterable = response.body as AsyncIterable<Uint8Array>;
  if (typeof asyncIterable[Symbol.asyncIterator] === 'function') {
    for await (const chunk of asyncIterable) {
      yield chunk;
    }
    return;
  }

  if (!response.body.getReader) {
    return;
  }

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

export async function assertOkResponse(
  response: TTSFetchResponse,
  url: string,
): Promise<void> {
  if (response.ok) {
    return;
  }

  const details = await readResponseError(response);
  throw new PlumbusError(
    ErrorCode.Internal,
    `Voice TTS request failed with status ${response.status}`,
    { url, status: response.status, details },
  );
}

export async function readResponseError(response: Pick<TTSFetchResponse, 'text'>): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

export function decodeBase64Audio(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}

export function decodeHexAudio(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'hex'));
}

export function socketMessageToString(data: WebSocket.RawData): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
}
