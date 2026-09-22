import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import {
  fakeSttRegistration,
  fakeTtsRegistration,
  fakeTransportRegistration,
} from '../../providers/__tests__/fake-registrations.js';
import { createProviderRegistry } from '../../providers/registry.js';
import { registerVoiceRoutes } from '../http.js';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payloadSegment = token.split('.')[1];
  if (!payloadSegment) {
    throw new Error('JWT payload segment missing');
  }
  const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
}

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

describe('room token route', () => {
  it('merges beforeSession.room metadata into the minted token response for any minting transport', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'assistant',
      access: {},
      transport: {
        provider: 'room',
        mode: 'continuous',
        options: { agentAudioTrackName: 'agent-voice' },
      },
      stt: { provider: 'custom-stt', languages: ['he', 'en'] },
      tts: { provider: 'custom-tts', voiceId: 'voice-1', locale: 'he-IL' },
      brain: {
        async run() {
          return { text: 'ok' };
        },
      },
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
        registry: createProviderRegistry({
          transport: { room: fakeTransportRegistration('room') },
          stt: { 'custom-stt': fakeSttRegistration('custom-stt') },
          tts: { 'custom-tts': fakeTtsRegistration('custom-tts') },
        }),
        providers: {
          providers: {
            room: {
              url: 'wss://room.example.test',
              apiKey: 'room-key',
              apiSecret: 'room-secret',
            },
            'custom-stt': { apiKey: 'stt-key' },
            'custom-tts': { apiKey: 'tts-key' },
          },
        },
        beforeSession: async () => ({
          room: {
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
      url: '/api/voice/assistant/token',
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
    expect(body.transport).toBe('room');
    expect(body.room).toBe('session-abc');
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.agentAudioTrackName).toBe('agent-voice');
    expect(body.execution).toEqual({
      userId: 'user-1',
      tenantId: 'tenant-1',
      input: { projectId: 'proj-1' },
    });
    expect(body).toMatchObject({
      noiseCancellation: { placement: 'off', engine: 'none', model: null },
    });

    const payload = decodeJwtPayload(body.token);
    const roomConfig = payload.roomConfig as {
      agents?: Array<{ agentName?: string; metadata?: string }>;
    };
    expect(roomConfig.agents?.[0]?.agentName).toBe('assistant');
    expect(roomConfig.agents?.[0]?.metadata).toContain('proj-1');
    expect(roomConfig.agents?.[0]?.metadata).toContain('he');

    await app.close();
  });
});
