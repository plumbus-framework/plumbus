import type { Room } from '@livekit/rtc-node';
import { createTestContext } from '@plumbus/core/testing';
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { LIVEKIT_TRANSPORT_REGISTRATION, startVoiceWorker } from '../index.js';
import type { LiveKitWorkerConnection } from '../types.js';

describe('voice livekit simulated integration', () => {
  it('runs a turn and records transport cost when the worker stops', async () => {
    let brainCalls = 0;
    let onData: ((payload: unknown) => Promise<void> | void) | undefined;
    const disconnect = vi.fn(async () => {});
    const ctx = createTestContext();
    const recordCost = vi.spyOn(ctx.ai, 'recordProviderCost');
    const voice = defineVoice({
      name: 'livekitE2E',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: {
        async run() {
          brainCalls += 1;
          return { text: 'livekit e2e ok' };
        },
      },
    });

    const handle = await startVoiceWorker({
      voices: [voice],
      providers: {
        providers: {
          livekit: {
            url: 'wss://livekit.example.test',
            apiKey: 'test-key',
            apiSecret: 'test-secret',
          },
        },
      },
      registry: createProviderRegistry({
        transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION },
      }),
      createExecutionContext: () => ctx,
      connectLiveKitWorker: async (transport, args) => {
        onData = args.onData;
        (transport as unknown as { activeConnection: unknown }).activeConnection = {
          room: {
            localParticipant: {
              publishData: async () => {},
            },
            disconnect: async () => {},
          },
          audioSource: { captureFrame: async () => {}, close: async () => {} },
          localTrack: { close: async () => {} },
          dataTopic: 'voice.events',
        };

        return {
          room: {} as Room,
          disconnect,
        } satisfies LiveKitWorkerConnection;
      },
    });

    try {
      expect(onData).toBeTypeOf('function');
      await onData?.({ type: 'stt.final', text: 'livekit hello' });
      await onData?.({ type: 'ptt.up' });
      await vi.waitFor(() => expect(brainCalls).toBe(1));
    } finally {
      await handle.stop();
    }
    expect(disconnect).toHaveBeenCalledOnce();
    expect(recordCost).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'livekit',
        model: 'livekit-cloud',
        operation: 'transport',
      }),
      expect.objectContaining({
        operationName: 'voice.transport',
        relatedEntityId: handle.sessionId,
      }),
    );
  });
});
