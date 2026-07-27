import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineVoice, runVoiceTurn } from '@plumbus/voice';
import {
  createMockSTTProvider,
  createMockTransportProvider,
  createMockTTSProvider,
} from '@plumbus/voice/testing';
import { describe, expect, it } from 'vitest';

describe('LiveKit-style transport publish deduplication', () => {
  it('publishes each TTS chunk once when onAudioChunk is not wired', async () => {
    const publishedChunks: Uint8Array[] = [];
    const ctx = createTestContext({
      auth: { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI(),
    });

    const voice = defineVoice({
      name: 'livekitStyleVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'mock-stt' },
      tts: { provider: 'mock-tts' },
      brain: {
        async run(_ctx, args) {
          args.onAssistantDelta?.('One sentence.');
          return { text: 'One sentence.' };
        },
      },
    });

    const ttsProvider = createMockTTSProvider({
      async *synthesizeStream() {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4]);
      },
    });

    const transportProvider = createMockTransportProvider({
      publishAudio(chunk) {
        publishedChunks.push(chunk);
      },
    });

    for await (const _event of runVoiceTurn(ctx, {
      voiceDefinition: voice,
      sessionId: 'single-publish-session',
      transcript: 'hello',
      sttProvider: createMockSTTProvider(),
      ttsProvider,
      transportProvider,
    })) {
      // consume events
    }

    expect(publishedChunks).toHaveLength(2);
    expect(publishedChunks[0]).toEqual(new Uint8Array([1, 2]));
    expect(publishedChunks[1]).toEqual(new Uint8Array([3, 4]));
  });
});
