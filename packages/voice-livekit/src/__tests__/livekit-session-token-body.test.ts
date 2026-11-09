import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  Room: class {
    on() {}
    async connect() {}
    async disconnect() {}
    localParticipant = {
      async setMicrophoneEnabled() {},
      async publishData() {},
      getTrackPublication: () => ({
        track: {
          setProcessor: async () => undefined,
        },
      }),
    };
    remoteParticipants = new Map();
  },
  RoomEvent: {
    DataReceived: 'dataReceived',
    TrackSubscribed: 'trackSubscribed',
  },
  Track: {
    Source: {
      Microphone: 'microphone',
    },
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

    const { createLiveKitVoiceSession } = await import('../client/livekit-session.js');
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

  it('echoes the plumbus_voice_csrf cookie in the x-plumbus-voice-csrf header', async () => {
    vi.stubGlobal('document', { cookie: 'session=abc; plumbus_voice_csrf=nonce.sig%3D; other=1' });
    try {
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(
            JSON.stringify({ url: 'wss://lk.test', token: 't', room: 'r', identity: 'u' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      const { createLiveKitVoiceSession } = await import('../client/livekit-session.js');
      await createLiveKitVoiceSession({ voiceName: 'assistant', tokenUrl: '/token' });
      const [, init] = fetchMock.mock.calls[0] ?? [];
      const headers = init?.headers as Record<string, string>;
      expect(headers['x-plumbus-voice-csrf']).toBe('nonce.sig=');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('sends no CSRF header when the cookie is absent', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ url: 'wss://lk.test', token: 't', room: 'r', identity: 'u' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const { createLiveKitVoiceSession } = await import('../client/livekit-session.js');
    await createLiveKitVoiceSession({ voiceName: 'assistant', tokenUrl: '/token' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers as Record<string, string>).not.toHaveProperty('x-plumbus-voice-csrf');
  });
});
