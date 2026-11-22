// ── Mock provider adapter ──
// Test double at the adapter seam: a provider adapter that records every request (images
// included) and answers from a script. It goes through the real AI service, so its checks (image
// capability, size guard, budgets, ledger) run in app tests. `blankPng` makes valid PNG fixtures.

import { deflateSync } from 'node:zlib';
import { contentHasImages, estimateUnscaledImageTokens } from '../ai/image-input.js';
import type {
  AIProviderAdapter,
  AIProviderCapabilities,
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
} from '../ai/provider.js';

export interface MockAIProviderOptions {
  /** Adapter name (default `'mock'`). */
  name?: string;
  /**
   * The answer text: a fixed string, or computed from the request (default `'{}'`). A non-string
   * answer is sent as JSON.
   */
  respond?: string | ((request: ProviderRequest) => unknown);
  /** Declared capabilities; `imageInput` defaults to `true` (set `false` to test the refusal). */
  capabilities?: Partial<AIProviderCapabilities>;
  /** Reported usage per call (default 10 input / 5 output tokens). */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface MockAIProvider extends AIProviderAdapter {
  /** Every request the adapter received, in order. */
  readonly requests: ProviderRequest[];
  /** True when the request at `index` carried at least one image. */
  hadImages(index?: number): boolean;
}

/**
 * A scripted `AIProviderAdapter` for `createAIService({ providers: { mock: mockAIProvider() } })`.
 * Declares image input by default and estimates images at width × height / 750.
 */
export function mockAIProvider(options: MockAIProviderOptions = {}): MockAIProvider {
  const requests: ProviderRequest[] = [];
  const usage = options.usage ?? { inputTokens: 10, outputTokens: 5 };
  const capabilities: AIProviderCapabilities = {
    tools: false,
    streamingTools: false,
    parallelToolCalls: false,
    parallelToolCallControl: false,
    namedToolChoice: false,
    imageInput: true,
    ...options.capabilities,
  };
  const answer = (request: ProviderRequest): string => {
    const respond = options.respond ?? '{}';
    const value = typeof respond === 'function' ? respond(request) : respond;
    return typeof value === 'string' ? value : JSON.stringify(value);
  };
  const tokenUsage = {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  };
  return {
    name: options.name ?? 'mock',
    capabilities,
    requests,
    hadImages(index = requests.length - 1) {
      const request = requests[index];
      if (!request) return false;
      if ((request.images?.length ?? 0) > 0) return true;
      return (request.messages ?? []).some(
        (message) => message.role === 'user' && contentHasImages(message.content),
      );
    },
    estimateImageInputTokens(image) {
      return estimateUnscaledImageTokens(image.width, image.height);
    },
    async complete(request): Promise<ProviderResponse> {
      requests.push(request);
      return {
        content: answer(request),
        model: request.model ?? 'mock-model',
        usage: tokenUsage,
        finishReason: 'stop',
      };
    },
    async *stream(request): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      yield { type: 'content_delta', delta: answer(request) };
      yield { type: 'done', usage: tokenUsage, finishReason: 'stop' };
    },
    async embed(request) {
      return {
        embeddings: request.texts.map(() => [0]),
        model: 'mock-embedding',
        usage: { totalTokens: request.texts.length },
      };
    },
  };
}

// ── PNG ──

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** A white greyscale PNG of the given size (test fixture). */
export function blankPng(width: number, height: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const raw = new Uint8Array((width + 1) * height).fill(0xff);
  for (let row = 0; row < height; row += 1) raw[row * (width + 1)] = 0; // filter: none
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
