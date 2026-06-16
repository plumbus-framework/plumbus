import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../index.js';
import { mockVoiceRuntime } from '../../testing/index.js';

describe('browser-tts smoke', () => {
  it('emits tts.speak for client playback without server audio chunks', async () => {
    const voice = defineVoice({
      name: 'browserPlaybackVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'browser-default' },
      brain: {
        async run() {
          return { text: 'Hello from the browser voice runtime.' };
        },
      },
    });

    const result = await mockVoiceRuntime(voice, {
      transcript: 'hello',
      transcriptSource: 'client-stt',
    });

    expect(result.events.filter((event) => event.type === 'tts.speak')).toHaveLength(1);
    expect(result.audioChunks).toEqual([]);
  });
});
