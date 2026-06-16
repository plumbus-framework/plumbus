import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const roomHandlers = new Map<string, Set<(...args: unknown[]) => void>>();
let latestProcessor: { onaudioprocess: ((event: { inputBuffer: AudioBufferLike }) => void) | null };

interface AudioBufferLike {
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

const mockLocalParticipant = {
  setMicrophoneEnabled: vi.fn(async () => undefined),
  publishData: vi.fn(async () => undefined),
};

const mockRoom = {
  remoteParticipants: new Map<string, { trackPublications: Map<string, MockPublication> }>(),
  localParticipant: mockLocalParticipant,
  on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    const handlers = roomHandlers.get(event) ?? new Set();
    handlers.add(handler);
    roomHandlers.set(event, handlers);
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
};

interface MockPublication {
  trackSid: string;
  trackName?: string;
  isSubscribed: boolean;
  track?: MockAudioTrack;
}

interface MockAudioTrack {
  mediaStreamTrack: MediaStreamTrack;
}

vi.mock('livekit-client', () => ({
  Room: vi.fn(() => mockRoom),
  RoomEvent: {
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
  },
  isAudioTrack: vi.fn(() => true),
}));

function emitRoomEvent(event: string, ...args: unknown[]) {
  for (const handler of roomHandlers.get(event) ?? []) {
    handler(...args);
  }
}

class MockAudioContext {
  sampleRate = 48_000;
  destination = {};

  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }

  createScriptProcessor() {
    const processor = {
      onaudioprocess: null as ((event: { inputBuffer: AudioBufferLike }) => void) | null,
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    latestProcessor = processor;
    return processor;
  }

  createGain() {
    return {
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }

  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
}

describe('createLiveKitVoiceSession', () => {
  beforeEach(() => {
    roomHandlers.clear();
    mockRoom.remoteParticipants.clear();
    mockLocalParticipant.setMicrophoneEnabled.mockClear();
    mockLocalParticipant.publishData.mockClear();
    mockRoom.connect.mockClear();
    mockRoom.disconnect.mockClear();
    latestProcessor = { onaudioprocess: null };

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        url: 'wss://livekit.example.test',
        token: 'lk-token',
        room: 'voice-room',
        identity: 'user-1',
        agentAudioTrackName: 'dvora-voice',
      }),
    })));

    vi.stubGlobal('AudioContext', MockAudioContext as never);
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(public readonly tracks: MediaStreamTrack[]) {}
    });
    vi.stubGlobal('TextEncoder', TextEncoder);
    vi.stubGlobal('TextDecoder', TextDecoder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('wires TrackSubscribed to onAudioChunk and DataReceived to onEvent', async () => {
    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const audioChunks: Uint8Array[] = [];
    const events: unknown[] = [];

    const session = await createLiveKitVoiceSession({
      voiceName: 'dvora',
      tokenUrl: '/api/voice/dvora/token',
      onAudioChunk: (chunk) => {
        audioChunks.push(chunk);
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    await session.connect();

    const track: MockAudioTrack = { mediaStreamTrack: {} as MediaStreamTrack };
    const publication: MockPublication = {
      trackSid: 'track-1',
      trackName: 'dvora-voice',
      isSubscribed: true,
      track,
    };
    emitRoomEvent('trackSubscribed', track, publication);

    expect(latestProcessor.onaudioprocess).toBeTypeOf('function');
    latestProcessor.onaudioprocess?.({
      inputBuffer: {
        sampleRate: 48_000,
        getChannelData: () => new Float32Array([0.25, -0.25, 0.5, -0.5]),
      },
    });
    expect(audioChunks.length).toBe(1);
    expect(audioChunks[0]!.byteLength).toBeGreaterThan(0);
    expect(audioChunks[0]!.byteLength % 2).toBe(0);

    const payload = new TextEncoder().encode(
      JSON.stringify({ type: 'agent.state', state: 'Listening' }),
    );
    emitRoomEvent('dataReceived', payload);
    expect(events).toEqual([{ type: 'agent.state', state: 'Listening' }]);

    await session.disconnect();
    expect(mockRoom.disconnect).toHaveBeenCalled();
  });

  it('publishes push-to-talk control frames over LiveKit data', async () => {
    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const session = await createLiveKitVoiceSession({
      voiceName: 'dvora',
      tokenUrl: '/api/voice/dvora/token',
    });

    await session.connect();
    await session.ptt.down();
    await session.ptt.up({ transcript: 'shalom' });

    expect(mockLocalParticipant.publishData).toHaveBeenCalledTimes(2);
    const downPayload = JSON.parse(
      new TextDecoder().decode(mockLocalParticipant.publishData.mock.calls[0]![0] as Uint8Array),
    );
    const upPayload = JSON.parse(
      new TextDecoder().decode(mockLocalParticipant.publishData.mock.calls[1]![0] as Uint8Array),
    );
    expect(downPayload).toEqual({ type: 'ptt.down' });
    expect(upPayload).toEqual({ type: 'ptt.up', transcript: 'shalom' });
  });
});
