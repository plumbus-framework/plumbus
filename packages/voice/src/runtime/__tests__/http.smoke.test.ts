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

describe('voice http smoke', () => {
  it('returns 401 without authentication', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'browserVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: { authenticate: async () => null },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: {
          providers: {
            livekit: { apiKey: 'livekit-key', apiSecret: 'livekit-secret' },
          },
        },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/browserVoice/session',
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 403 when evaluateAccess denies minting', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'adminVoice',
      access: { roles: ['admin'] },
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async () => ({
            userId: 'user-1',
            roles: ['user'],
            scopes: [],
            provider: 'test',
          }),
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: { providers: {} },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/adminVoice/session',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('returns 200 with wsUrl and sessionToken but no provider secrets', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'allowedVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async () => ({
            userId: 'user-1',
            roles: ['user'],
            scopes: [],
            provider: 'test',
          }),
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: {
          providers: {
            livekit: { apiKey: 'super-secret-api-key', apiSecret: 'super-secret-api-secret' },
          },
        },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/allowedVoice/session',
      headers: { authorization: 'Bearer user-token', host: 'example.test' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { wsUrl: string; sessionToken: string };
    expect(body.wsUrl).toBe('ws://example.test/api/voice/allowedVoice/stream');
    expect(typeof body.sessionToken).toBe('string');
    expect(JSON.stringify(body)).not.toContain('super-secret-api-key');
    expect(JSON.stringify(body)).not.toContain('super-secret-api-secret');
    expect(JSON.stringify(body)).not.toContain('voicePromptId');
    await app.close();
  });

  it('returns 400 when a livekit voice is bootstrapped through the websocket session route', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'livekitVoice',
      access: {},
      transport: { provider: 'livekit' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async () => ({
            userId: 'user-1',
            roles: ['user'],
            scopes: [],
            provider: 'test',
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
          },
        },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/livekitVoice/session',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'Voice does not use the websocket transport' });
    await app.close();
  });

  it('serves the health route for an authorized caller', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'healthyVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
      brain: { async run() { return { text: 'ok' }; } },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async () => ({
            userId: 'user-1',
            roles: ['user'],
            scopes: [],
            provider: 'test',
          }),
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: { providers: {} },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'GET',
      url: '/api/voice/healthyVoice/health',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      voiceName: 'healthyVoice',
      transport: 'websocket',
      providersValidated: true,
    });
    await app.close();
  });
});
