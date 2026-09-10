import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVEKIT_TRANSPORT_REGISTRATION } from '../index.js';
import { createProviderRegistry, createTransportProvider } from '@plumbus/voice';
import type { LiveKitTransportProvider } from '../types.js';

const sdk = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  publish: vi.fn(async () => {}),
  trackClose: vi.fn(async () => {}),
  sourceClose: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
}));

vi.mock('@livekit/rtc-node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@livekit/rtc-node')>();
  return {
    ...actual,
    Room: class {
      localParticipant = { publishTrack: sdk.publish };
      connect = sdk.connect;
      disconnect = sdk.disconnect;
      on() {}
    },
    AudioSource: class {
      close = sdk.sourceClose;
    },
    LocalAudioTrack: { createAudioTrack: () => ({ close: sdk.trackClose }) },
  };
});

function transport() {
  return createTransportProvider({
    registry: createProviderRegistry({ transport: { livekit: LIVEKIT_TRANSPORT_REGISTRATION } }),
    providers: {
      providers: {
        livekit: {
          url: 'wss://livekit.example.test',
          apiKey: 'test-key',
          apiSecret: 'test-secret',
        },
      },
    },
    voiceSlice: { provider: 'livekit' },
  }) as LiveKitTransportProvider;
}

const args = { voiceName: 'lifecycle', room: 'lifecycle', identity: 'worker' };

describe('LiveKit native resource lifecycle', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('disconnects the room when connecting rejects', async () => {
    const error = new Error('connection failed');
    sdk.connect.mockRejectedValue(error);
    await expect(transport().connectWorker(args)).rejects.toBe(error);
    expect(sdk.disconnect).toHaveBeenCalledOnce();
    expect(sdk.trackClose).not.toHaveBeenCalled();
  });

  it('closes partially initialized resources on track publication failure', async () => {
    const error = new Error('publish failed');
    sdk.publish.mockRejectedValue(error);
    sdk.trackClose.mockRejectedValue(new Error('close failed'));
    await expect(transport().connectWorker(args)).rejects.toBe(error);
    expect(sdk.trackClose).toHaveBeenCalledOnce();
    expect(sdk.sourceClose).toHaveBeenCalledOnce();
    expect(sdk.disconnect).toHaveBeenCalledOnce();
  });

  it('waits for the same cleanup on concurrent disconnects', async () => {
    const t = transport();
    const connection = await t.connectWorker(args);
    let release: (() => void) | undefined;
    sdk.trackClose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = t.disconnect();
    expect(t.disconnect()).toBe(first);
    const second = connection.disconnect();
    try {
      await vi.waitFor(() => expect(sdk.disconnect).toHaveBeenCalledOnce());
      expect(sdk.sourceClose).toHaveBeenCalledOnce();
    } finally {
      release?.();
      await Promise.all([first, second]);
    }
    expect(sdk.trackClose).toHaveBeenCalledOnce();
  });

  it('can connect and clean up a subsequent room after stopping', async () => {
    const t = transport();
    await t.connectWorker(args);
    await t.disconnect();
    await t.connectWorker({ ...args, room: 'next-room' });
    await t.disconnect();
    expect(sdk.disconnect).toHaveBeenCalledTimes(2);
    expect(sdk.trackClose).toHaveBeenCalledTimes(2);
  });
});
