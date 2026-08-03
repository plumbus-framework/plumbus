import { EventEmitter } from 'node:events';
import { createProviderRegistry, createSTTProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import {
  OPENAI_REALTIME_CONNECTION_MODEL,
  OPENAI_REALTIME_STT_REGISTRATION,
  type OpenAIRealtimeSessionLike,
  resolveOpenAIRealtimeBaseURL,
} from '../openai-realtime-stt.js';

class FakeRealtimeSession extends EventEmitter implements OpenAIRealtimeSessionLike {
  readonly sent: Record<string, unknown>[] = [];
  readonly socket = {
    readyState: 1,
    once: () => this.socket,
    off: () => this.socket,
  };

  send(event: Record<string, unknown>): void {
    this.sent.push(event);
    if (event.type === 'input_audio_buffer.commit') {
      queueMicrotask(() => {
        this.emit('conversation.item.input_audio_transcription.completed', {
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'testing one two',
        });
      });
    }
  }

  close(): void {}
}

describe('OpenAI Realtime STT via openai SDK', () => {
  it('opens a transcription session and streams GA client events through the SDK', async () => {
    const session = new FakeRealtimeSession();
    const realtimeFactory = vi.fn(
      async (args: { apiKey: string; baseURL?: string; model: string }) => {
        expect(args.apiKey).toBe('openai-key');
        expect(args.baseURL).toBe('https://realtime.openai.test/v1');
        expect(args.model).toBe(OPENAI_REALTIME_CONNECTION_MODEL);
        return session;
      },
    );

    const registry = createProviderRegistry({
      stt: { 'openai-realtime': OPENAI_REALTIME_STT_REGISTRATION },
    });
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          'openai-realtime': {
            apiKey: 'openai-key',
            baseUrl: 'https://realtime.openai.test/v1',
            options: { openaiRealtimeFactory: realtimeFactory },
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

    expect(realtimeFactory).toHaveBeenCalledTimes(1);
    expect(session.sent[0]).toMatchObject({
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
    expect(session.sent[1]).toMatchObject({
      type: 'input_audio_buffer.append',
      audio: Buffer.from([10, 20, 30, 40]).toString('base64'),
    });
    expect(session.sent.at(-1)).toEqual({ type: 'input_audio_buffer.commit' });
    expect(finalized).toMatchObject({ final: true, text: 'testing one two' });
    expect(transcripts.at(-1)).toEqual({ final: true, text: 'testing one two' });
  });

  it('converts wss credential bases to https for the SDK client', () => {
    expect(
      resolveOpenAIRealtimeBaseURL({
        apiKey: 'k',
        baseUrl: 'wss://proxy.example/v1/',
      }),
    ).toBe('https://proxy.example/v1');
  });
});
