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
  getTrackPublication: vi.fn(() => ({
    track: {
      setProcessor: vi.fn(async () => undefined),
    },
  })),
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

interface MockMediaElement {
  autoplay: boolean;
  muted: boolean;
  style: { display: string };
  play: () => Promise<void>;
  pause: () => void;
  remove: () => void;
}

interface MockAudioTrack {
  mediaStreamTrack: MediaStreamTrack;
  attach: () => MockMediaElement;
}

function createMockAudioTrack(): MockAudioTrack {
  const element: MockMediaElement = {
    autoplay: false,
    muted: true,
    style: { display: '' },
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    remove: vi.fn(),
  };
  return {
    mediaStreamTrack: {} as MediaStreamTrack,
    attach: vi.fn(() => element),
  };
}

vi.mock('livekit-client', () => ({
  Room: vi.fn(() => mockRoom),
  RoomEvent: {
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
    TrackUnsubscribed: 'trackUnsubscribed',
  },
  Track: {
    Source: {
      Microphone: 'microphone',
    },
  },
  isAudioTrack: vi.fn(() => true),
}));

vi.mock('@livekit/krisp-noise-filter', () => ({
  KrispNoiseFilter: vi.fn(() => ({ name: 'krisp-mock' })),
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

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          url: 'wss://livekit.example.test',
          token: 'lk-token',
          room: 'voice-room',
          identity: 'user-1',
          agentAudioTrackName: 'agent-voice',
        }),
      })),
    );

    vi.stubGlobal('AudioContext', MockAudioContext as never);
    vi.stubGlobal(
      'MediaStream',
      class MediaStream {
        constructor(public readonly tracks: MediaStreamTrack[]) {}
      },
    );
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
      voiceName: 'assistant',
      tokenUrl: '/api/voice/assistant/token',
      onAudioChunk: (chunk) => {
        audioChunks.push(chunk);
      },
      onEvent: (event) => {
        events.push(event);
      },
    });

    await session.connect();

    const track: MockAudioTrack = createMockAudioTrack();
    const publication: MockPublication = {
      trackSid: 'track-1',
      trackName: 'agent-voice',
      isSubscribed: true,
      track,
    };
    emitRoomEvent('trackSubscribed', track, publication);

    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(latestProcessor.onaudioprocess).toBeTypeOf('function');
    latestProcessor.onaudioprocess?.({
      inputBuffer: {
        sampleRate: 48_000,
        getChannelData: () => new Float32Array([0.25, -0.25, 0.5, -0.5]),
      },
    });
    expect(audioChunks.length).toBe(1);
    expect(audioChunks[0]?.byteLength).toBeGreaterThan(0);
    expect(audioChunks[0]?.byteLength % 2).toBe(0);

    const payload = new TextEncoder().encode(
      JSON.stringify({ type: 'agent.state', state: 'Listening' }),
    );
    emitRoomEvent('dataReceived', payload);
    expect(events).toEqual([{ type: 'agent.state', state: 'Listening' }]);

    await session.disconnect();
    expect(mockRoom.disconnect).toHaveBeenCalled();
  });

  it('keeps only one agent audio sink across duplicate track subscriptions', async () => {
    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const session = await createLiveKitVoiceSession({
      voiceName: 'assistant',
      tokenUrl: '/api/voice/assistant/token',
    });

    await session.connect();

    const firstTrack = createMockAudioTrack();
    const firstPublication: MockPublication = {
      trackSid: 'track-1',
      trackName: 'agent-voice',
      isSubscribed: true,
      track: firstTrack,
    };
    emitRoomEvent('trackSubscribed', firstTrack, firstPublication);

    const secondTrack = createMockAudioTrack();
    const secondPublication: MockPublication = {
      trackSid: 'track-2',
      trackName: 'agent-voice',
      isSubscribed: true,
      track: secondTrack,
    };
    emitRoomEvent('trackSubscribed', secondTrack, secondPublication);

    expect(firstTrack.attach).toHaveBeenCalledTimes(1);
    expect(secondTrack.attach).toHaveBeenCalledTimes(1);
    const firstElement = firstTrack.attach.mock.results[0]?.value as MockMediaElement;
    const secondElement = secondTrack.attach.mock.results[0]?.value as MockMediaElement;
    expect(firstElement.remove).toHaveBeenCalled();
    expect(secondElement.remove).not.toHaveBeenCalled();

    emitRoomEvent('trackSubscribed', secondTrack, secondPublication);
    expect(secondTrack.attach).toHaveBeenCalledTimes(1);

    await session.disconnect();
  });

  it('publishes push-to-talk control frames over LiveKit data', async () => {
    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const session = await createLiveKitVoiceSession({
      voiceName: 'assistant',
      tokenUrl: '/api/voice/assistant/token',
    });

    await session.connect();
    await session.ptt.down();
    await session.ptt.up({ transcript: 'shalom' });

    expect(mockLocalParticipant.publishData).toHaveBeenCalledTimes(2);
    const downPayload = JSON.parse(
      new TextDecoder().decode(mockLocalParticipant.publishData.mock.calls[0]?.[0] as Uint8Array),
    );
    const upPayload = JSON.parse(
      new TextDecoder().decode(mockLocalParticipant.publishData.mock.calls[1]?.[0] as Uint8Array),
    );
    expect(downPayload).toEqual({ type: 'ptt.down' });
    expect(upPayload).toEqual({ type: 'ptt.up', transcript: 'shalom' });
  });

  it('applies client Krisp when token includes client BVC config', async () => {
    const { KrispNoiseFilter } = await import('@livekit/krisp-noise-filter');
    vi.mocked(global.fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        url: 'wss://livekit.example.test',
        token: 'lk-token',
        room: 'voice-room',
        identity: 'user-1',
        agentAudioTrackName: 'agent-voice',
        noiseCancellation: {
          placement: 'client',
          engine: 'krisp',
          model: 'bvc',
        },
      }),
    } as Response);

    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const session = await createLiveKitVoiceSession({
      voiceName: 'assistant',
      tokenUrl: '/api/voice/assistant/token',
    });

    await session.connect();

    expect(mockLocalParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true, {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
    });
    expect(KrispNoiseFilter).toHaveBeenCalledWith({ useBVC: true, quality: 'medium' });
    const publication = mockLocalParticipant.getTrackPublication.mock.results[0]?.value as {
      track: { setProcessor: ReturnType<typeof vi.fn> };
    };
    expect(publication.track.setProcessor).toHaveBeenCalled();
  });
});
