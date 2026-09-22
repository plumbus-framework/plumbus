import { PlumbusError, ErrorCode } from '@plumbus/core';
import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import type { VoiceProviderCredentials } from '../../types/provider.js';
import type { VoiceSttConfig } from '../../types/voice.js';
import type { STTProviderAudioChunk } from '../base/stt-provider.js';

export interface RuntimeFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type RuntimeFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: FormData;
  },
) => Promise<RuntimeFetchResponse>;

export interface RuntimeWebSocket {
  send(data: string | Uint8Array | Buffer): void;
  close(code?: number, reason?: string): void;
  on(
    event: 'message',
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): this;
  once(event: 'open', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
}

export type RuntimeWebSocketFactory = (
  url: string,
  init?: { headers?: Record<string, string> },
) => RuntimeWebSocket;

export interface AudioFormatInfo {
  bytesPerSecond: number;
  channels: number;
  encoding: 'pcm16' | 'unknown';
  sampleRate: number;
}

export function resolveRuntimeFetch(
  credentials: VoiceProviderCredentials,
  voiceSlice: VoiceSttConfig,
): RuntimeFetch {
  const injected =
    readOption<RuntimeFetch>(voiceSlice.options, 'fetch') ??
    readOption<RuntimeFetch>(credentials.options, 'fetch');
  if (injected) {
    return injected;
  }

  const nativeFetch = (globalThis as { fetch?: RuntimeFetch }).fetch;
  if (!nativeFetch) {
    throw new PlumbusError(
      ErrorCode.DependencyViolation,
      'STT provider requires a fetch implementation in this runtime.',
    );
  }
  return nativeFetch;
}

export function resolveRuntimeWebSocketFactory(
  credentials: VoiceProviderCredentials,
  voiceSlice: VoiceSttConfig,
): RuntimeWebSocketFactory {
  const injected =
    readOption<RuntimeWebSocketFactory>(voiceSlice.options, 'createWebSocket') ??
    readOption<RuntimeWebSocketFactory>(credentials.options, 'createWebSocket');
  if (injected) {
    return injected;
  }

  return (url, init) => {
    return new WebSocket(url, { headers: init?.headers }) as unknown as RuntimeWebSocket;
  };
}

export function resolveHttpBaseUrl(
  credentials: VoiceProviderCredentials,
  fallback: string,
): string {
  const baseUrl = credentials.baseUrl ?? fallback;
  return stripTrailingSlashes(baseUrl);
}

export function resolveWebSocketUrl(
  baseUrl: string | undefined,
  fallbackOrigin: string,
  endpointPath: string,
  query?: URLSearchParams,
): string {
  const fallback = new URL(endpointPath, fallbackOrigin);
  if (query) {
    fallback.search = query.toString();
  }

  if (!baseUrl) {
    return fallback.toString();
  }

  const normalizedBase = toWebSocketOrigin(baseUrl);
  const parsed = new URL(normalizedBase);
  if (!parsed.pathname || parsed.pathname === '/') {
    parsed.pathname = endpointPath;
  } else if (!parsed.pathname.endsWith(endpointPath)) {
    parsed.pathname = `${stripTrailingSlashes(parsed.pathname)}${endpointPath}`;
  }

  if (query) {
    for (const [key, value] of query.entries()) {
      if (!parsed.searchParams.has(key)) {
        parsed.searchParams.set(key, value);
      }
    }
  }

  return parsed.toString();
}

export function estimateAudioSeconds(audio: STTProviderAudioChunk): number {
  const format = parseAudioFormat(audio.contentType);
  return audio.chunk.byteLength / format.bytesPerSecond;
}

export function parseAudioFormat(contentType: string | undefined): AudioFormatInfo {
  const normalized = (contentType ?? '').toLowerCase();
  const sampleRate = parseIntegerToken(normalized, 'rate') ?? 16_000;
  const channels = parseIntegerToken(normalized, 'channels') ?? 1;

  if (normalized.includes('pcm')) {
    return {
      encoding: 'pcm16',
      sampleRate,
      channels,
      bytesPerSecond: sampleRate * channels * 2,
    };
  }

  return {
    encoding: 'unknown',
    sampleRate,
    channels,
    bytesPerSecond: Math.max(sampleRate * channels * 2, 32_000),
  };
}

export function concatAudioChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

export function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function toVendorAudioFormat(contentType: string | undefined): string {
  const format = parseAudioFormat(contentType);
  if (format.encoding === 'pcm16') {
    return 'pcm_s16le';
  }
  return 'auto';
}

export function wrapPcm16AsWav(audio: Uint8Array, contentType: string | undefined): Blob {
  const format = parseAudioFormat(contentType);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const byteRate = format.sampleRate * format.channels * 2;
  const blockAlign = format.channels * 2;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + audio.byteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, audio.byteLength, true);

  return toBlob([header, audio], 'audio/wav');
}

export function toBlobPart(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

export function toBlob(parts: Array<Uint8Array | ArrayBuffer | Buffer>, type: string): Blob {
  return new Blob(parts as ConstructorParameters<typeof Blob>[0], { type });
}

export function fileExtensionForContentType(contentType: string | undefined): string {
  const normalized = (contentType ?? '').toLowerCase();
  if (normalized.includes('wav') || normalized.includes('pcm')) return 'wav';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('m4a') || normalized.includes('mp4')) return 'm4a';
  return 'bin';
}

export function readOption<T>(
  options: Record<string, unknown> | undefined,
  key: string,
): T | undefined {
  const value = options?.[key];
  return value as T | undefined;
}

export class Deferred<T> {
  promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (reason?: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }

  reject(reason?: unknown): void {
    this.#reject(reason);
  }
}

function parseIntegerToken(contentType: string, name: string): number | undefined {
  const match = contentType.match(new RegExp(`${name}=([0-9]+)`));
  if (!match) return undefined;
  const value = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, '');
}

function toWebSocketOrigin(baseUrl: string): string {
  if (baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
    return baseUrl;
  }
  if (baseUrl.startsWith('http://')) {
    return `ws://${baseUrl.slice('http://'.length)}`;
  }
  if (baseUrl.startsWith('https://')) {
    return `wss://${baseUrl.slice('https://'.length)}`;
  }
  return `wss://${baseUrl}`;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
