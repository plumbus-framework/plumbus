import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { registerVoiceRoutes } from '../http.js';

function depsFromAuth(auth: {
  userId?: string;
  roles: string[];
  scopes: string[];
  provider: string;
  tenantId?: string;
}) {
  const ctx = createTestContext({ auth });
  return {
    auth: ctx.auth,
    data: ctx.data,
    events: ctx.events,
    flows: ctx.flows,
    ai: ctx.ai,
    audit: ctx.audit,
    logger: ctx.logger,
    time: ctx.time,
    config: {
      voiceSessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
    },
    security: ctx.security,
    translations: ctx.translations,
  };
}

describe('livekit token route', () => {
  it('merges beforeSession.livekit metadata into the minted token response', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'dvora',
      access: {},
      transport: {
        provider: 'livekit',
        mode: 'continuous',
        options: { agentAudioTrackName: 'dvora-voice' },
      },
      stt: { provider: 'soniox', languages: ['he', 'en'] },
      tts: { provider: 'deepdub', voiceId: 'voice-1', locale: 'he-IL' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async () => ({
            userId: 'user-1',
            tenantId: 'tenant-1',
            roles: ['user'],
            scopes: [],
            provider: 'jwt',
          }),
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: {
          providers: {
            livekit: {
              url: 'wss://livekit.example.test',
              apiKey: 'livekit-key',
              apiSecret: 'livekit-secret',
            },
            soniox: { apiKey: 'soniox-key' },
            deepdub: { apiKey: 'deepdub-key' },
          },
        },
        beforeSession: async () => ({
          livekit: {
            roomName: 'session-abc',
            identity: 'user-1',
            tokenTtlSeconds: 3600,
            metadata: { projectId: 'proj-1', language: 'he' },
            attributes: { tenantId: 'tenant-1' },
          },
          execution: {
            userId: 'user-1',
            tenantId: 'tenant-1',
            input: { projectId: 'proj-1' },
          },
        }),
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/dvora/token',
      headers: { authorization: 'Bearer user-token' },
      payload: { sessionId: 'session-abc' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      transport: string;
      room: string;
      token: string;
      agentAudioTrackName?: string;
      execution?: { userId: string; tenantId: string };
    };
    expect(body.transport).toBe('livekit');
    expect(body.room).toBe('session-abc');
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.agentAudioTrackName).toBe('dvora-voice');
    expect(body.execution).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
      input: { projectId: 'proj-1' },
    });

    await app.close();
  });
});
