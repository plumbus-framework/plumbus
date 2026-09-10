import { createTestContext } from '@plumbus/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { defineVoice } from '../../index.js';
import {
  createMockSTTProvider,
  createMockTransportProvider,
  createMockTTSProvider,
} from '../../testing/index.js';
import { runVoiceTurn } from '../run-turn.js';

const voice = defineVoice({
  name: 'asyncDelta',
  access: {},
  transport: { provider: 'websocket' },
  stt: { provider: 'mock-stt' },
  tts: { provider: 'mock-tts' },
  brain: {
    async run(_ctx, args) {
      args.onAssistantDelta?.('Hello ');
      args.onAssistantDelta?.('there.');
      return { text: 'Hello there.' };
    },
  },
});

describe('asynchronous assistant delta delivery', () => {
  it('waits for pending delta delivery before finalizing TTS and preserves order', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    const spoken: string[] = [];
    let started = false;
    let completed = false;
    const published = vi.fn();
    const run = (async () => {
      for await (const event of runVoiceTurn(createTestContext(), {
        voiceDefinition: voice,
        sessionId: 'async-delta',
        transcript: 'hello',
        sttProvider: createMockSTTProvider(),
        ttsProvider: createMockTTSProvider({
          async *synthesizeStream(text) {
            spoken.push(text);
            yield new Uint8Array([1, 2]);
          },
        }),
        transportProvider: createMockTransportProvider({ publishAudio: published }),
        async onAssistantDelta(delta) {
          started = true;
          if (delta === 'Hello ') await gate;
          delivered.push(delta);
        },
      })) {
        if (event.type === 'turn.completed') completed = true;
      }
    })();
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      expect(completed).toBe(false);
    } finally {
      release?.();
      await run;
    }
    expect(delivered).toEqual(['Hello ', 'there.']);
    expect(spoken).toEqual(['Hello there.']);
    expect(published).toHaveBeenCalledOnce();
    expect(completed).toBe(true);
  });

  it('reports delivery failure without an unhandled callback rejection or false completion', async () => {
    const events: string[] = [];
    for await (const event of runVoiceTurn(createTestContext(), {
      voiceDefinition: voice,
      sessionId: 'failed-delta',
      transcript: 'hello',
      sttProvider: createMockSTTProvider(),
      ttsProvider: createMockTTSProvider(),
      transportProvider: createMockTransportProvider(),
      async onAssistantDelta() {
        throw new Error('data channel failed');
      },
    }))
      events.push(event.type);
    expect(events).toContain('turn.failed');
    expect(events).not.toContain('turn.completed');
  });
});
