import { describe, expect, it, vi } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import type { LiveKitTransportProvider } from '../../providers/transport/livekit-transport.js';
import { startVoiceWorker } from '../worker.js';

describe('startVoiceWorker', () => {
  it('requires createExecutionContext', async () => {
    const voice = defineVoice({
      name: 'lkVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    await expect(
      startVoiceWorker({
        voices: [voice],
        providers: {
          providers: {
            livekit: {
              url: 'wss://livekit.example.test',
              apiKey: 'lk-key',
              apiSecret: 'lk-secret',
            },
          },
        },
      } as never),
    ).rejects.toThrow(/createExecutionContext/);
  });

  it('runs a mock turn when connectLiveKitWorker is injected', async () => {
    let brainRan = false;
    let incomingOnData: ((payload: unknown) => Promise<void> | void) | undefined;
    const publishedEvents: unknown[] = [];

    const voice = defineVoice({
      name: 'lkMockVoice',
      access: {},
      transport: { provider: 'livekit', audioFormat: 'pcm16-16k' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          brainRan = true;
          return { text: 'worker brain response' };
        },
      },
    });

    const handle = await startVoiceWorker({
      voices: [voice],
      providers: {
        providers: {
          livekit: {
            url: 'wss://livekit.example.test',
            apiKey: 'lk-key',
            apiSecret: 'lk-secret',
          },
        },
      },
      createExecutionContext: () => createTestContext(),
      connectLiveKitWorker: async (transport, args) => {
        incomingOnData = args.onData;
        primeTransportForSendData(transport, publishedEvents);
        return {
          room: {} as never,
          disconnect: async () => {},
        };
      },
    });

    await incomingOnData?.({ type: 'stt.final', text: 'hello worker' });
    await incomingOnData?.({ type: 'ptt.up' });

    await vi.waitFor(() => {
      expect(brainRan).toBe(true);
      expect(publishedEvents.some((event) => isEventType(event, 'turn.completed'))).toBe(true);
    });

    await handle.stop();
  });
});

function primeTransportForSendData(
  transport: LiveKitTransportProvider,
  publishedEvents: unknown[],
): void {
  const connection = {
    dataTopic: 'voice.events',
    localTrack: { close: async () => {} },
    audioSource: { close: async () => {} },
    room: {
      localParticipant: {
        publishData: async (encoded: Uint8Array) => {
          publishedEvents.push(JSON.parse(Buffer.from(encoded).toString('utf8')));
        },
      },
      disconnect: async () => {},
    },
  };

  Object.defineProperty(transport, 'activeConnection', {
    value: connection,
    writable: true,
    configurable: true,
  });
}

function isEventType(event: unknown, type: string): boolean {
  return typeof event === 'object' && event !== null && (event as { type?: string }).type === type;
}
