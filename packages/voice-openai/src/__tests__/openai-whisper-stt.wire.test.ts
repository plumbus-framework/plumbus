import { createProviderRegistry, createSTTProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_WHISPER_STT_REGISTRATION } from '../openai-whisper-stt.js';

describe('OpenAI Whisper STT wire protocol', () => {
  it('posts multipart audio transcription requests with auth and model fields', async () => {
    const fetcher = vi.fn(
      async (
        url: string,
        init?: { method?: string; headers?: Record<string, string>; body?: FormData },
      ) => {
        expect(url).toBe('https://api.openai.test/v1/audio/transcriptions');
        expect(init?.method).toBe('POST');
        expect(init?.headers?.Authorization).toBe('Bearer openai-key');
        expect(init?.headers?.Accept).toBe('application/json');

        const body = init?.body;
        expect(body).toBeInstanceOf(FormData);
        expect(body?.get('model')).toBe('whisper-1');
        expect(body?.get('response_format')).toBe('json');
        expect(body?.get('language')).toBe('en');

        const upload = body?.get('file');
        expect(upload).toBeInstanceOf(File);
        const bytes = new Uint8Array(await (upload as File).arrayBuffer());
        expect(Buffer.from(bytes.slice(0, 4)).toString('utf-8')).toBe('RIFF');
        expect((upload as File).type).toBe('audio/wav');

        return new Response(JSON.stringify({ text: 'batch transcript' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    );

    const registry = createProviderRegistry({
      stt: { 'openai-whisper': OPENAI_WHISPER_STT_REGISTRATION },
    });
    const provider = createSTTProvider({
      registry,
      providers: {
        providers: {
          'openai-whisper': {
            apiKey: 'openai-key',
            baseUrl: 'https://api.openai.test/v1',
            options: { fetch: fetcher },
          },
        },
      },
      voiceSlice: {
        provider: 'openai-whisper',
        model: 'whisper-1',
        languages: ['en'],
      },
    });

    const transcripts: Array<{ final: boolean; text: string }> = [];
    await provider.connect({
      sessionId: 'openai-whisper-session',
      onTranscript(event) {
        transcripts.push({ final: event.final, text: event.text });
      },
    });
    provider.sendAudio?.({
      chunk: Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]),
      contentType: 'pcm16;rate=16000;channels=1',
    });

    const finalized = await provider.finalize?.();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(finalized).toMatchObject({ final: true, text: 'batch transcript' });
    expect(transcripts).toContainEqual({ final: true, text: 'batch transcript' });
  });
});
