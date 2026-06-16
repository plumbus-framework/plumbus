import { describe, expect, it } from 'vitest';
import { createWsFixture } from '../../stt/__tests__/wire-fixtures.js';
import { createProviderRegistry } from '../../registry.js';
import { createTTSProvider } from '../../factory.js';

describe('Deepdub TTS wire protocol', () => {
  it('opens a websocket, sends text-to-speech payload, and yields audio chunks', async () => {
    const fixture = await createWsFixture('/open');
    fixture.onConnection((socket) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as {
          action?: string;
          targetText?: string;
          generationId?: string;
        };
        expect(payload.action).toBe('text-to-speech');
        expect(payload.targetText).toBe('Shalom');
        expect(payload.generationId).toBeTypeOf('string');
        socket.send(
          JSON.stringify({ generationId: payload.generationId, data: Buffer.from([1, 2, 3, 4]).toString('base64') }),
        );
        socket.send(JSON.stringify({ generationId: payload.generationId, isFinished: true }));
      });
    });

    const registry = createProviderRegistry();
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          deepdub: {
            apiKey: 'deepdub-key',
            baseUrl: fixture.url.replace('/open', '').replace('ws://', 'http://'),
            options: {
              webSocketFactory: fixture.createWebSocket,
            },
          },
        },
      },
      voiceSlice: {
        provider: 'deepdub',
        model: 'dd-etts-3.0',
        voiceId: 'voice-1',
        locale: 'he-IL',
      },
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream!('Shalom', provider.mapDeliveryTone({}))) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBeGreaterThan(0);
    await fixture.close();
  });

  it('sends abort when synthesis is cancelled via AbortSignal', async () => {
    const fixture = await createWsFixture('/open');
    const abortMessages: Array<Record<string, unknown>> = [];
    fixture.onConnection((socket) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (payload.action === 'abort') {
          abortMessages.push(payload);
        }
      });
    });

    const registry = createProviderRegistry();
    const provider = createTTSProvider({
      registry,
      providers: {
        providers: {
          deepdub: {
            apiKey: 'deepdub-key',
            baseUrl: fixture.url.replace('/open', '').replace('ws://', 'http://'),
            options: {
              webSocketFactory: fixture.createWebSocket,
            },
          },
        },
      },
      voiceSlice: {
        provider: 'deepdub',
        model: 'dd-etts-3.0',
        voiceId: 'voice-1',
        locale: 'he-IL',
      },
    });

    const abortController = new AbortController();
    const stream = provider.synthesizeStream!(
      'Shalom',
      provider.mapDeliveryTone({}),
      abortController.signal,
    );
    const pending = stream.next();
    await new Promise((resolve) => setTimeout(resolve, 20));
    abortController.abort();
    await pending.catch(() => undefined);
    provider.abortAll();

    await waitFor(() => abortMessages.length > 0);
    expect(abortMessages[0]).toMatchObject({
      action: 'abort',
      realtime: true,
    });
    expect(abortMessages[0]?.generationId).toBeTypeOf('string');
    await fixture.close();
  });

  it('sends abort when abortGeneration is called directly', async () => {
    const fixture = await createWsFixture('/open');
    const abortMessages: Array<Record<string, unknown>> = [];
    const generationIds: string[] = [];

    fixture.onConnection((socket) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (payload.action === 'text-to-speech' && typeof payload.generationId === 'string') {
          generationIds.push(payload.generationId);
        }
        if (payload.action === 'abort') {
          abortMessages.push(payload);
        }
      });
    });

    const provider = createDeepdubProvider(fixture);
    const stream = provider.synthesizeStream!('First phrase', provider.mapDeliveryTone({}));
    const pending = stream.next();
    await waitFor(() => generationIds.length > 0);
    provider.abortGeneration!(generationIds[0]!);
    await pending.catch(() => undefined);

    await waitFor(() => abortMessages.length > 0);
    expect(abortMessages[0]).toMatchObject({
      action: 'abort',
      generationId: generationIds[0],
      realtime: true,
    });
    await fixture.close();
  });

  it('sends abort for every active generation when abortAll is called', async () => {
    const fixture = await createWsFixture('/open');
    const abortMessages: Array<Record<string, unknown>> = [];
    const ttsMessages: Array<Record<string, unknown>> = [];

    fixture.onConnection((socket) => {
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (payload.action === 'text-to-speech') {
          ttsMessages.push(payload);
        }
        if (payload.action === 'abort') {
          abortMessages.push(payload);
        }
      });
    });

    const provider = createDeepdubProvider(fixture);
    const first = provider.synthesizeStream!('One', provider.mapDeliveryTone({}));
    const firstPending = first.next();
    await waitFor(() => ttsMessages.length >= 1);
    const second = provider.synthesizeStream!('Two', provider.mapDeliveryTone({}));
    const secondPending = second.next();
    await waitFor(() => ttsMessages.length >= 2);
    provider.abortAll();

    await Promise.allSettled([firstPending, secondPending]);
    await waitFor(() => abortMessages.length >= 2);
    expect(abortMessages).toHaveLength(2);
    expect(new Set(abortMessages.map((message) => message.generationId)).size).toBe(2);
    await fixture.close();
  });

  it('reuses one websocket connection across two synthesizeStream calls in a turn', async () => {
    const fixture = await createWsFixture('/open');
    const connectionIds: string[] = [];
    const ttsMessages: Array<Record<string, unknown>> = [];

    fixture.onConnection((socket) => {
      connectionIds.push(`conn-${connectionIds.length + 1}`);
      socket.on('message', (raw) => {
        const payload = JSON.parse(raw.toString()) as Record<string, unknown>;
        if (payload.action === 'text-to-speech') {
          ttsMessages.push(payload);
          socket.send(
            JSON.stringify({
              generationId: payload.generationId,
              data: Buffer.from([9, 9, 9, 9]).toString('base64'),
            }),
          );
          socket.send(JSON.stringify({ generationId: payload.generationId, isFinished: true }));
        }
      });
    });

    const provider = createDeepdubProvider(fixture);
    const firstChunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream!('Shalom', provider.mapDeliveryTone({}))) {
      firstChunks.push(chunk);
    }
    const secondChunks: Uint8Array[] = [];
    for await (const chunk of provider.synthesizeStream!('Lehitraot', provider.mapDeliveryTone({}))) {
      secondChunks.push(chunk);
    }

    expect(connectionIds).toEqual(['conn-1']);
    expect(ttsMessages).toHaveLength(2);
    expect(ttsMessages[0]?.targetText).toBe('Shalom');
    expect(ttsMessages[1]?.targetText).toBe('Lehitraot');
    expect(firstChunks.length).toBeGreaterThan(0);
    expect(secondChunks.length).toBeGreaterThan(0);
    await fixture.close();
  });
});

function createDeepdubProvider(fixture: Awaited<ReturnType<typeof createWsFixture>>) {
  const registry = createProviderRegistry();
  return createTTSProvider({
    registry,
    providers: {
      providers: {
        deepdub: {
          apiKey: 'deepdub-key',
          baseUrl: fixture.url.replace('/open', '').replace('ws://', 'http://'),
          options: {
            webSocketFactory: fixture.createWebSocket,
          },
        },
      },
    },
    voiceSlice: {
      provider: 'deepdub',
      model: 'dd-etts-3.0',
      voiceId: 'voice-1',
      locale: 'he-IL',
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for fixture messages');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
