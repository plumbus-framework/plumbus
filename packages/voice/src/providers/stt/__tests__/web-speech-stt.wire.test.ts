import { describe, expect, it } from 'vitest';
import { createProviderRegistry } from '../../registry.js';
import { createSTTProvider } from '../../factory.js';

describe('Web Speech STT relay behavior', () => {
  it('relays client final transcripts and never requires server audio upload', async () => {
    const registry = createProviderRegistry();
    const provider = createSTTProvider({
      registry,
      providers: { providers: { 'web-speech': {} } },
      voiceSlice: { provider: 'web-speech' },
    });

    const seen: Array<{ final: boolean; text: string; language?: string }> = [];
    await provider.connect({
      sessionId: 'web-speech-session',
      onTranscript(event) {
        seen.push({ final: event.final, text: event.text, language: event.language });
      },
    });

    expect(provider.sendAudio).toBeUndefined();

    await provider.onClientTranscript?.({
      text: 'hello from chrome',
      final: true,
      language: 'en',
    });

    const finalized = await provider.finalize?.();

    expect(seen).toEqual([{ final: true, text: 'hello from chrome', language: 'en' }]);
    expect(finalized).toEqual({ text: 'hello from chrome', final: true, language: 'en' });
  });
});
