import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  Room: class {
    on() {}
    async connect() {}
    async disconnect() {}
    localParticipant = {
      async setMicrophoneEnabled() {},
      async publishData() {},
    };
    remoteParticipants = new Map();
  },
  RoomEvent: {
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
  },
  isAudioTrack: () => false,
}));

describe('createLiveKitVoiceSession token body', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges tokenRequestBody into the token POST payload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          url: 'wss://livekit.example.test',
          token: 'token',
          room: 'session-1',
          identity: 'user-1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const { createLiveKitVoiceSession } = await import('../livekit-session.js');
    const session = await createLiveKitVoiceSession({
      voiceName: 'assistant',
      tokenUrl: '/api/voice/assistant/token',
      tokenRequestBody: {
        projectId: 'p',
        sessionId: 's',
        language: 'he',
      },
    });

    await session.connect();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      voiceName: 'assistant',
      projectId: 'p',
      sessionId: 's',
      language: 'he',
    });
  });
});
