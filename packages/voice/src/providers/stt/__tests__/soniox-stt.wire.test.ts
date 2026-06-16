import { afterEach, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createSTTProvider } from '../../factory.js';
import { createWsFixture, toJsonMessages } from './wire-fixtures.js';

describe('Soniox STT wire protocol', () => {
  const fixtures: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      await fixtures.pop()?.close();
    }
  });

  it('opens Soniox websocket, sends config, streams binary audio, and finalizes', async () => {
    const fixture = await createWsFixture('/transcribe-websocket');
    fixtures.push(fixture);
    fixture.onConnection((socket, record) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.type === 'finalize') {
            socket.send(
              JSON.stringify({
                tokens: [{ text: 'hello world', is_final: true }],
              }),
            );
          }
        }
      });
    });

    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          soniox: {
            apiKey: 'soniox-key',
            baseUrl: fixture.url,
            options: { createWebSocket: fixture.createWebSocket },
          },
        },
      },
      voiceSlice: { provider: 'soniox', model: 'stt-rt-preview', languages: ['en'] },
    });

    const transcripts: Array<{ final: boolean; text: string }> = [];
    await provider.connect({
      sessionId: 'soniox-session',
      onTranscript(event) {
        transcripts.push({ final: event.final, text: event.text });
      },
    });

    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });
    const finalized = await provider.finalize?.();
    provider.disconnect?.();

    await waitFor(() => (fixture.connections[0]?.messages.length ?? 0) >= 3);
    const connection = fixture.connections[0];
    expect(connection).toBeTruthy();
    const jsonMessages = toJsonMessages(connection);
    expect(connection.url).toBe('/transcribe-websocket');
    expect(jsonMessages[0]).toMatchObject({
      api_key: 'soniox-key',
      audio_format: 'pcm_s16le',
      language_hints: ['en'],
      model: 'stt-rt-preview',
    });
    expect(connection.messages.some((message) => message.binary)).toBe(true);
    expect(jsonMessages.at(-1)).toEqual({ type: 'finalize' });
    expect(finalized).toMatchObject({ final: true, text: 'hello world' });
    expect(transcripts.at(-1)).toEqual({ final: true, text: 'hello world' });
  });

  it('sends Soniox context.terms when contextTerms is configured', async () => {
    const fixture = await createWsFixture('/transcribe-websocket');
    fixtures.push(fixture);
    fixture.onConnection((socket) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.type === 'finalize') {
            socket.send(JSON.stringify({ tokens: [{ text: 'shalom', is_final: true }] }));
          }
        }
      });
    });

    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          soniox: {
            apiKey: 'soniox-key',
            baseUrl: fixture.url,
            options: { createWebSocket: fixture.createWebSocket },
          },
        },
      },
      voiceSlice: {
        provider: 'soniox',
        model: 'stt-rt-preview',
        languages: ['he'],
        options: { contextTerms: ['Dvora', 'MemoirAi'] },
      },
    });

    await provider.connect({ sessionId: 'soniox-context' });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });
    await provider.finalize?.();
    provider.disconnect?.();

    await waitFor(() => (fixture.connections[0]?.messages.length ?? 0) >= 2);
    const jsonMessages = toJsonMessages(fixture.connections[0]!);
    expect(jsonMessages[0]).toMatchObject({
      context: { terms: ['Dvora', 'MemoirAi'] },
    });
  });

  it('invokes onEndpoint when Soniox signals speech end', async () => {
    const fixture = await createWsFixture('/transcribe-websocket');
    fixtures.push(fixture);
    fixture.onConnection((socket) => {
      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          socket.send(JSON.stringify({ endpoint: true, tokens: [{ text: 'hello', is_final: true }] }));
        }
      });
    });

    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          soniox: {
            apiKey: 'soniox-key',
            baseUrl: fixture.url,
            options: { createWebSocket: fixture.createWebSocket },
          },
        },
      },
      voiceSlice: { provider: 'soniox', model: 'stt-rt-preview', languages: ['he'] },
    });

    let endpointCount = 0;
    await provider.connect({
      sessionId: 'soniox-endpoint',
      onEndpoint() {
        endpointCount += 1;
      },
    });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([1, 2, 3, 4]),
      contentType: 'pcm16;rate=16000;channels=1',
    });
    await waitFor(() => endpointCount > 0);
    provider.disconnect?.();
    await fixture.close();
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for fixture messages');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
