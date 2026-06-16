#!/usr/bin/env node
import { defineVoice } from '../src/define/defineVoice.js';
import { createMockSTTProvider, createMockTTSProvider, createMockTransportProvider } from '../src/testing/mock-providers.js';
import { createTestContext } from '../../plumbus-core/src/testing/context.js';
import { runVoiceTurn } from '../src/runtime/run-turn.js';

async function main(): Promise<void> {
  const voice = defineVoice({
    name: 'smokeVoice',
    access: {},
    transport: { provider: 'websocket' },
    stt: { provider: 'mock-stt' },
    tts: { provider: 'mock-tts' },
    brain: {
      async run() {
        return { text: 'voice smoke OK' };
      },
    },
  });

  const ctx = createTestContext();
  for await (const event of runVoiceTurn(ctx, {
    voiceDefinition: voice,
    sessionId: 'voice-smoke-session',
    transcript: 'hello smoke',
    sttProvider: createMockSTTProvider(),
    ttsProvider: createMockTTSProvider(),
    transportProvider: createMockTransportProvider(),
    cleanupProviders: true,
  })) {
    if (event.type === 'turn.completed') {
      console.log('voice smoke OK');
      return;
    }
  }

  throw new Error('voice smoke failed: turn did not complete');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
