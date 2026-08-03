import { ErrorCode, PlumbusError } from '@plumbus/core';
import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { MINIMAX_TTS_REGISTRATION } from '../minimax-tts.js';

function createHttpProvider(
  fetcher: ReturnType<typeof vi.fn>,
  credentialsOptions: Record<string, unknown> = {},
) {
  const registry = createProviderRegistry({
    tts: { minimax: MINIMAX_TTS_REGISTRATION },
  });
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        minimax: {
          apiKey: 'minimax-key',
          baseUrl: 'https://api.minimax.test',
          options: { fetch: fetcher, streamingMode: 'http', ...credentialsOptions },
        },
      },
    },
    voiceSlice: {
      provider: 'minimax',
      model: 'speech-2.8-turbo',
      voiceId: 'voice-1',
      options: { streamingMode: 'http' },
    },
  });
}

describe('MiniMax TTS wire protocol', () => {
  it('streams audio over HTTP SSE', async () => {
    const fetcher = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      expect(url).toContain('/v1/t2a_v2');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body ?? '{}') as { stream?: boolean; text?: string };
      expect(body.stream).toBe(true);
      expect(body.text).toBe('Shalom');

      const audioHex = Buffer.from([1, 2, 3, 4]).toString('hex');
      return {
        ok: true,
        status: 200,
        async text() {
          return '';
        },
        async json() {
          return {};
        },
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from(
              `data: ${JSON.stringify({
                data: { audio: audioHex, status: 1 },
                base_resp: { status_code: 0, status_msg: 'success' },
              })}\n\n`,
            );
          },
        },
      };
    });

    const provider = createHttpProvider(fetcher);
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(fetcher).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('plays only status=1 audio and prefers usage_characters from status=2', async () => {
    const playableHex = Buffer.from([1, 2, 3, 4]).toString('hex');
    const aggregatedHex = Buffer.from([9, 9, 9, 9]).toString('hex');
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return {};
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            `data: ${JSON.stringify({
              data: { audio: playableHex, status: 1 },
              base_resp: { status_code: 0 },
            })}\n\n`,
          );
          yield Buffer.from(
            `data: ${JSON.stringify({
              data: { audio: aggregatedHex, status: 2 },
              extra_info: { usage_characters: 42 },
              base_resp: { status_code: 0 },
            })}\n\n`,
          );
        },
      },
    }));

    const provider = createHttpProvider(fetcher);
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(provider.usage()).toEqual([
      expect.objectContaining({ quantity: 42, unit: 'characters' }),
    ]);
  });

  it('appends GroupId to the HTTP request URL when configured', async () => {
    const fetcher = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.minimax.test/v1/t2a_v2?GroupId=group-123');
      return {
        ok: true,
        status: 200,
        async text() {
          return '';
        },
        async json() {
          return {};
        },
        body: {
          async *[Symbol.asyncIterator]() {},
        },
      };
    });

    const provider = createHttpProvider(fetcher, { groupId: 'group-123' });
    for await (const _chunk of provider.synthesizeStream('hi', provider.mapDeliveryTone({}))) {
      // drain
    }
    expect(fetcher).toHaveBeenCalled();
  });

  it('ignores incomplete trailing SSE frames without a blank-line terminator', async () => {
    const audioHex = Buffer.from([9, 8, 7, 6]).toString('hex');
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return {};
      },
      body: {
        async *[Symbol.asyncIterator]() {
          // Spec-compliant SSE requires a blank line; eventsource-parser drops incomplete events.
          yield Buffer.from(`data: ${JSON.stringify({ data: { audio: audioHex, status: 1 } })}`);
        },
      },
    }));

    const provider = createHttpProvider(fetcher);
    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });

  it('throws when HTTP SSE reports a non-zero base_resp.status_code', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return {};
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            `data: ${JSON.stringify({
              data: { audio: '', status: 1 },
              base_resp: { status_code: 1004, status_msg: 'rate limited' },
              trace_id: 'trace-abc',
            })}\n\n`,
          );
        },
      },
    }));

    const provider = createHttpProvider(fetcher);
    await expect(async () => {
      for await (const _chunk of provider.synthesizeStream(
        'Shalom',
        provider.mapDeliveryTone({}),
      )) {
        // drain
      }
    }).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Unauthorized &&
        error.metadata?.statusCode === 1004 &&
        error.metadata?.category === 'auth' &&
        error.metadata?.traceId === 'trace-abc',
    );
  });

  it('maps rate-limit status codes with category metadata', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      async text() {
        return '';
      },
      async json() {
        return {};
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(
            `data: ${JSON.stringify({
              data: { audio: '', status: 1 },
              base_resp: { status_code: 1002, status_msg: 'rate limited' },
            })}\n\n`,
          );
        },
      },
    }));

    const provider = createHttpProvider(fetcher);
    await expect(async () => {
      for await (const _chunk of provider.synthesizeStream(
        'Shalom',
        provider.mapDeliveryTone({}),
      )) {
        // drain
      }
    }).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Internal &&
        error.metadata?.statusCode === 1002 &&
        error.metadata?.category === 'rateLimit',
    );
  });

  it('streams audio over WebSocket task protocol', async () => {
    const sent: string[] = [];
    const webSocketFactory = vi.fn((url: string) => {
      expect(url).toBe('wss://api.minimax.test/ws/v1/t2a_v2?GroupId=group-ws');
      const listeners = new Map<string, Array<(data?: unknown) => void>>();
      const socket = {
        send(data: string) {
          sent.push(data);
          const payload = JSON.parse(data) as { event?: string };
          if (payload.event === 'task_start') {
            queueMicrotask(() =>
              listeners.get('message')?.forEach((fn) => {
                fn(
                  JSON.stringify({
                    event: 'task_started',
                    base_resp: { status_code: 0, status_msg: 'success' },
                  }),
                );
              }),
            );
          }
          if (payload.event === 'task_continue') {
            const audioHex = Buffer.from([5, 6, 7, 8]).toString('hex');
            queueMicrotask(() =>
              listeners.get('message')?.forEach((fn) => {
                fn(
                  JSON.stringify({
                    event: 'task_continued',
                    data: { audio: audioHex },
                    is_final: true,
                    extra_info: { usage_characters: 11 },
                    base_resp: { status_code: 0, status_msg: 'success' },
                  }),
                );
              }),
            );
          }
        },
        close() {},
        on(event: string, listener: (data?: unknown) => void) {
          const bucket = listeners.get(event) ?? [];
          bucket.push(listener);
          listeners.set(event, bucket);
          if (event === 'open') {
            queueMicrotask(() => listener());
          }
          if (event === 'message' && sent.length === 0) {
            queueMicrotask(() =>
              listener(
                JSON.stringify({
                  event: 'connected_success',
                  base_resp: { status_code: 0, status_msg: 'success' },
                }),
              ),
            );
          }
        },
      };
      return socket;
    });

    const registry = createProviderRegistry({
      tts: { minimax: MINIMAX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          minimax: {
            apiKey: 'minimax-key',
            baseUrl: 'https://api.minimax.test',
            options: { webSocketFactory, groupId: 'group-ws' },
          },
        },
      },
      voiceSlice: {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        voiceId: 'voice-1',
        options: { streamingMode: 'websocket' },
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(webSocketFactory).toHaveBeenCalled();
    expect(sent.some((message) => message.includes('"task_start"'))).toBe(true);
    expect(sent.some((message) => message.includes('"task_continue"'))).toBe(true);
    expect(sent.some((message) => message.includes('"task_finish"'))).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
    expect(provider.usage()).toEqual([
      expect.objectContaining({ quantity: 11, unit: 'characters' }),
    ]);
  });

  it('throws on WebSocket task_failed / non-zero base_resp', async () => {
    const webSocketFactory = vi.fn((_url: string) => {
      const listeners = new Map<string, Array<(data?: unknown) => void>>();
      return {
        send() {},
        close() {},
        on(event: string, listener: (data?: unknown) => void) {
          const bucket = listeners.get(event) ?? [];
          bucket.push(listener);
          listeners.set(event, bucket);
          if (event === 'open') {
            queueMicrotask(() => listener());
          }
          if (event === 'message') {
            queueMicrotask(() =>
              listener(
                JSON.stringify({
                  event: 'task_failed',
                  base_resp: { status_code: 1004, status_msg: 'rate limited' },
                  trace_id: 'ws-trace',
                }),
              ),
            );
          }
        },
      };
    });

    const registry = createProviderRegistry({
      tts: { minimax: MINIMAX_TTS_REGISTRATION },
    });
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          minimax: {
            apiKey: 'minimax-key',
            baseUrl: 'https://api.minimax.test',
            options: { webSocketFactory },
          },
        },
      },
      voiceSlice: {
        provider: 'minimax',
        model: 'speech-2.8-turbo',
        voiceId: 'voice-1',
        options: { streamingMode: 'websocket' },
      },
    });

    await expect(async () => {
      for await (const _chunk of provider.synthesizeStream(
        'Shalom',
        provider.mapDeliveryTone({}),
      )) {
        // drain
      }
    }).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof PlumbusError &&
        error.code === ErrorCode.Unauthorized &&
        error.metadata?.statusCode === 1004 &&
        error.metadata?.category === 'auth' &&
        error.metadata?.traceId === 'ws-trace',
    );
  });
});
