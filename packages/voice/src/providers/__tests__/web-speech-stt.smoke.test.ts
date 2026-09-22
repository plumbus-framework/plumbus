import { describe, expect, it, vi } from 'vitest';
import { createProviderRegistry, defineVoice } from '../../index.js';
import { mockVoiceRuntime } from '../../testing/index.js';
import { createSTTProvider } from '../factory.js';

describe('web-speech STT smoke', () => {
  it('relays client transcript text without sending server audio', async () => {
    const registry = createProviderRegistry();
    const sttProvider = createSTTProvider({
      registry,
      providers: { providers: { 'web-speech': {} } },
      voiceSlice: { provider: 'web-speech' },
    });
    const sendAudio = vi.fn();
    sttProvider.sendAudio = sendAudio;
    sttProvider.onClientTranscript?.({
      text: 'שלום עולם',
      final: true,
      language: 'he',
    });

    const seenTranscripts: string[] = [];
    const voice = defineVoice({
      name: 'clientSpeechVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run(_ctx, args) {
          seenTranscripts.push(args.transcript ?? '');
          return { text: 'התקבל' };
        },
      },
    });

    const result = await mockVoiceRuntime(voice, {
      transcript: 'שלום עולם',
      transcriptSource: 'client-stt',
      sttProvider,
    });

    expect(seenTranscripts).toEqual(['שלום עולם']);
    expect(sendAudio).not.toHaveBeenCalled();
    expect(result.events.some((event) => event.type === 'turn.completed')).toBe(true);
    expect(
      result.recordedCosts.some(
        (entry) =>
          typeof entry.record === 'object' &&
          entry.record !== null &&
          'operation' in entry.record &&
          entry.record.operation === 'transcribe',
      ),
    ).toBe(false);
  });
});
