import { createTestContext } from '@plumbus/core/testing';
import { createProviderRegistry, defineVoice } from '@plumbus/voice';
import { describe, expect, it, vi } from 'vitest';
import { joinVoiceRoomSession, LIVEKIT_TRANSPORT_REGISTRATION } from '../index.js';

function setup() {
  const ctx = createTestContext();
  const cost = vi.spyOn(ctx.ai, 'recordProviderCost');
  const trackClose = vi.fn(async () => {});
  const sourceClose = vi.fn(async () => {});
  const roomDisconnect = vi.fn(async () => {});
  const connectionDisconnect = vi.fn(async () => {});
  const publishData = vi.fn(async () => {});
  const connected = vi.fn(async () => {});
  const voice = defineVoice({
    name: 'shutdownTest',
    access: {},
    transport: { provider: 'livekit' },
    stt: { provider: 'web-speech' },
    tts: { provider: 'browser-tts' },
    brain: {
      async run() {
        return { text: 'ok' };
      },
    },
  });
  const start = () =>
    joinVoiceRoomSession({
      voice,
      roomName: 'shutdown-test',
      providers: {
        providers: {
          livekit: {
            url: 'wss://livekit.example.test',
            apiKey: 'test-key',
            apiSecret: 'test-secret',
          },
        },
      },
      registry: createProviderRegistry({ transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION } }),
      createExecutionContext: () => ctx,
      connectLiveKitWorker: async (transport) => {
        Object.defineProperty(transport, 'activeConnection', {
          configurable: true,
          writable: true,
          value: {
            room: { localParticipant: { publishData }, disconnect: roomDisconnect },
            audioSource: { close: sourceClose },
            localTrack: { close: trackClose },
            dataTopic: 'voice.events',
          },
        });
        await connected();
        return { room: {} as never, disconnect: connectionDisconnect };
      },
    });
  return {
    start,
    cost,
    trackClose,
    sourceClose,
    roomDisconnect,
    connectionDisconnect,
    publishData,
    connected,
  };
}

describe('room session lifecycle', () => {
  it('shares concurrent and repeated stop calls without duplicate cost or cleanup', async () => {
    const f = setup();
    const handle = await f.start();
    const first = handle.stop();
    expect(handle.stop()).toBe(first);
    await first;
    await handle.stop();
    for (const call of [
      f.cost,
      f.trackClose,
      f.sourceClose,
      f.roomDisconnect,
      f.connectionDisconnect,
    ]) {
      expect(call).toHaveBeenCalledOnce();
    }
  });

  it('disconnects before awaiting a pending cost recorder', async () => {
    const f = setup();
    let resolveCost: (() => void) | undefined;
    f.cost.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCost = resolve;
        }),
    );
    const handle = await f.start();
    const stopped = handle.stop();
    try {
      await vi.waitFor(() => expect(f.cost).toHaveBeenCalledOnce());
      expect(f.roomDisconnect).toHaveBeenCalledOnce();
      expect(f.connectionDisconnect).toHaveBeenCalledOnce();
    } finally {
      resolveCost?.();
      await stopped;
    }
  });

  it('preserves accounting errors after cleanup without retrying the ledger write', async () => {
    const f = setup();
    const error = new Error('ledger unavailable');
    f.cost.mockRejectedValue(error);
    const handle = await f.start();
    await expect(handle.stop()).rejects.toBe(error);
    await expect(handle.stop()).rejects.toBe(error);
    expect(f.roomDisconnect).toHaveBeenCalledOnce();
    expect(f.connectionDisconnect).toHaveBeenCalledOnce();
    expect(f.cost).toHaveBeenCalledOnce();
  });

  it.each([
    'trackClose',
    'sourceClose',
    'roomDisconnect',
    'connectionDisconnect',
  ] as const)('attempts all cleanup and records cost when %s fails', async (method) => {
    const f = setup();
    const error = new Error('cleanup failed');
    f[method].mockRejectedValue(error);
    const handle = await f.start();
    await expect(handle.stop()).rejects.toBe(error);
    await expect(handle.stop()).rejects.toBe(error);
    for (const call of [
      f.trackClose,
      f.sourceClose,
      f.roomDisconnect,
      f.connectionDisconnect,
      f.cost,
    ]) {
      expect(call).toHaveBeenCalledOnce();
    }
  });

  it('cleans up a failed hello and preserves the startup error if cleanup also fails', async () => {
    const f = setup();
    const error = new Error('hello failed');
    f.publishData.mockRejectedValue(error);
    f.trackClose.mockRejectedValue(new Error('track close failed'));
    await expect(f.start()).rejects.toBe(error);
    expect(f.sourceClose).toHaveBeenCalledOnce();
    expect(f.roomDisconnect).toHaveBeenCalledOnce();
    expect(f.connectionDisconnect).toHaveBeenCalledOnce();
  });

  it('cleans up transport resources if the connection callback rejects', async () => {
    const f = setup();
    const error = new Error('connect failed');
    f.connected.mockRejectedValue(error);
    await expect(f.start()).rejects.toBe(error);
    expect(f.trackClose).toHaveBeenCalledOnce();
    expect(f.sourceClose).toHaveBeenCalledOnce();
    expect(f.roomDisconnect).toHaveBeenCalledOnce();
  });
});
