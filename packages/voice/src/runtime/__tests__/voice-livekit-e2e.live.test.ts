import { describe, expect, it } from 'vitest';
import { defineVoice } from '../../define/defineVoice.js';
import { startVoiceWorker } from '../worker.js';
import type { LiveKitWorkerConnection } from '../../providers/transport/livekit-transport.js';
import type { Room } from '@livekit/rtc-node';

const live = process.env.VOICE_LIVE_TEST === '1';

describe.runIf(live)('voice livekit e2e', () => {
  it('joins a LiveKit room when credentials are configured', async () => {
    const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      return;
    }

    let brainCalls = 0;
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
            url: LIVEKIT_URL,
            apiKey: LIVEKIT_API_KEY,
            apiSecret: LIVEKIT_API_SECRET,
          },
        },
      },
      createExecutionContext: () =>
        ({
          ai: {
            checkProviderCostBudget() {},
            async recordProviderCost() {},
          },
        }) as never,
      connectLiveKitWorker: async ({ onData, transport }) => {
        (transport as unknown as { activeConnection: unknown }).activeConnection = {
          room: {
            localParticipant: {
              publishData: async () => {},
            },
          },
          audioSource: { captureFrame: async () => {} },
          localTrack: { close: async () => {} },
          dataTopic: 'voice.events',
        };

        queueMicrotask(async () => {
          await onData?.({ type: 'stt.final', text: 'livekit hello' });
          await onData?.({ type: 'ptt.up' });
        });

        return {
          room: {} as Room,
          disconnect: async () => {},
        } satisfies LiveKitWorkerConnection;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    await handle.stop();
    expect(brainCalls).toBeGreaterThan(0);
  }, 60_000);
});

describe.skipIf(live)('voice livekit e2e', () => {
  it('is skipped unless VOICE_LIVE_TEST=1', () => {
    expect(process.env.VOICE_LIVE_TEST).not.toBe('1');
  });
});
