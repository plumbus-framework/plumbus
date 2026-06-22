import { afterEach, describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createSTTProvider } from '../../factory.js';
import { createWsFixture, toJsonMessages } from './wire-fixtures.js';

describe('OpenAI Realtime STT wire protocol', () => {
  const fixtures: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      await fixtures.pop()?.close();
    }
  });

  it('uses the GA realtime transcription websocket protocol', async () => {
    const fixture = await createWsFixture('/v1/realtime');
    fixtures.push(fixture);
    fixture.onConnection((socket) => {
      socket.on('message', (data, isBinary) => {
        if (isBinary) {
          return;
        }
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.type === 'input_audio_buffer.commit') {
          socket.send(
            JSON.stringify({
              type: 'conversation.item.input_audio_transcription.completed',
              transcript: 'testing one two',
            }),
          );
        }
      });
    });

    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          'openai-realtime': {
            apiKey: 'openai-key',
            baseUrl: fixture.url,
            options: { createWebSocket: fixture.createWebSocket },
          },
        },
      },
      voiceSlice: {
        provider: 'openai-realtime',
        model: 'gpt-realtime-whisper',
        languages: ['en'],
      },
    });

    const transcripts: Array<{ final: boolean; text: string }> = [];
    await provider.connect({
      sessionId: 'openai-realtime-session',
      onTranscript(event) {
        transcripts.push({ final: event.final, text: event.text });
      },
    });
    await provider.sendAudio?.({
      chunk: Uint8Array.from([10, 20, 30, 40]),
      contentType: 'pcm16;rate=24000;channels=1',
    });
    const finalized = await provider.finalize?.();

    const connection = fixture.connections[0];
    expect(connection).toBeTruthy();
    expect(connection.url).toBe('/v1/realtime?intent=transcription');
    expect(connection.headers.authorization).toBe('Bearer openai-key');

    const jsonMessages = toJsonMessages(connection);
    expect(jsonMessages[0]).toMatchObject({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { language: 'en', model: 'gpt-realtime-whisper' },
            turn_detection: null,
          },
        },
      },
    });
    expect(jsonMessages[1]).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: Buffer.from([10, 20, 30, 40]).toString('base64'),
    });
    expect(jsonMessages.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
    expect(finalized).toMatchObject({ final: true, text: 'testing one two' });
    expect(transcripts.at(-1)).toEqual({ final: true, text: 'testing one two' });
  });
});
