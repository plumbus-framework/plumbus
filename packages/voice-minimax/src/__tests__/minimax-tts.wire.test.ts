import { createProviderRegistry, createTTSProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { MINIMAX_TTS_REGISTRATION } from '../minimax-tts.js';

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
            yield Buffer.from(`data: ${JSON.stringify({ data: { audio: audioHex } })}\n\n`);
          },
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
            options: { fetch: fetcher, streamingMode: 'http' },
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

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(fetcher).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('streams audio over WebSocket task protocol', async () => {
    const sent: string[] = [];
    const webSocketFactory = vi.fn((url: string) => {
      expect(url).toBe('wss://api.minimax.test/ws/v1/t2a_v2');
      const listeners = new Map<string, Array<(data?: unknown) => void>>();
      const socket = {
        send(data: string) {
          sent.push(data);
          const payload = JSON.parse(data) as { event?: string };
          if (payload.event === 'task_start') {
            queueMicrotask(() =>
              listeners.get('message')?.forEach((fn) => {
                fn(JSON.stringify({ event: 'task_started' }));
              }),
            );
          }
          if (payload.event === 'task_continue') {
            const audioHex = Buffer.from([5, 6, 7, 8]).toString('hex');
            queueMicrotask(() =>
              listeners.get('message')?.forEach((fn) => {
                fn(JSON.stringify({ event: 'task_continued', data: { audio: audioHex } }));
              }),
            );
            queueMicrotask(() =>
              listeners.get('message')?.forEach((fn) => {
                fn(JSON.stringify({ event: 'task_finished' }));
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
            queueMicrotask(() => listener(JSON.stringify({ event: 'connected_success' })));
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

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(webSocketFactory).toHaveBeenCalled();
    expect(sent.some((message) => message.includes('"task_start"'))).toBe(true);
    expect(sent.some((message) => message.includes('"task_continue"'))).toBe(true);
    expect(sent.some((message) => message.includes('"task_finish"'))).toBe(true);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
