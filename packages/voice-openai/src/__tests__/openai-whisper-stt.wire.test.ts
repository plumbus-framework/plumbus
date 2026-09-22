import { createProviderRegistry, createSTTProvider } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { OPENAI_WHISPER_STT_REGISTRATION } from '../openai-whisper-stt.js';

describe('OpenAI Whisper STT via openai SDK', () => {
  it('calls audio.transcriptions.create with custom baseURL and upload file', async () => {
    const create = vi.fn(async (body: Record<string, unknown>) => {
      expect(body.model).toBe('whisper-1');
      expect(body.response_format).toBe('json');
      expect(body.language).toBe('en');
      expect(body.file).toBeTruthy();
      return { text: 'batch transcript' };
    });
    const clientFactory = vi.fn(({ apiKey, baseURL }: { apiKey: string; baseURL?: string }) => {
      expect(apiKey).toBe('openai-key');
      expect(baseURL).toBe('https://api.openai.test/v1');
      return {
        audio: {
          transcriptions: { create },
          speech: {
            create: async () => {
              throw new Error('unused');
            },
          },
        },
      };
    });

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
            options: { openaiClientFactory: clientFactory },
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

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(finalized).toMatchObject({ final: true, text: 'batch transcript' });
    expect(transcripts).toContainEqual({ final: true, text: 'batch transcript' });
  });
});
