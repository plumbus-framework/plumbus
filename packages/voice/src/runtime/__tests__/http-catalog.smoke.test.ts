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

describe('voice catalog smoke', () => {
  it('guards catalog routes behind the admin role', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'catalogVoice',
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
          authenticate: async (header?: string) => {
            if (header === 'Bearer admin-token') {
              return { userId: 'admin-1', roles: ['admin'], scopes: [], provider: 'test' };
            }
            return { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' };
          },
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

    const denied = await app.inject({
      method: 'GET',
      url: '/api/voice/catalog',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/voice/catalog',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(JSON.stringify(allowed.json())).toContain('catalogVoice');

    const stacksDenied = await app.inject({
      method: 'GET',
      url: '/api/voice/stacks',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(stacksDenied.statusCode).toBe(403);

    const stacksAllowed = await app.inject({
      method: 'GET',
      url: '/api/voice/stacks',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(stacksAllowed.statusCode).toBe(200);
    expect(JSON.stringify(stacksAllowed.json())).toContain('hebrew-production');

    const optionsAllowed = await app.inject({
      method: 'GET',
      url: '/api/voice/catalog/tts/elevenlabs/options',
      headers: { authorization: 'Bearer admin-token' },
    });
    expect(optionsAllowed.statusCode).toBe(200);

    await app.close();
  });
});
