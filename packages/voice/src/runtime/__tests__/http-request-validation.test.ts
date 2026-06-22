import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { registerVoiceRoutes } from '../http.js';

describe('voice HTTP request validation', () => {
  it('returns 400 for non-object token request bodies', async () => {
    const app = Fastify();
    const voice = defineVoice({
      name: 'assistant',
      access: { roles: ['user'] },
      transport: { provider: 'livekit', mode: 'continuous' },
      stt: { provider: 'soniox', languages: ['he'] },
      tts: { provider: 'deepdub', voiceId: 'voice-1' },
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
        createDependencies: (auth) => {
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
            config: ctx.config,
            security: ctx.security,
            translations: ctx.translations,
          };
        },
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
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/assistant/token',
      headers: { authorization: 'Bearer user-token' },
      payload: ['not', 'an', 'object'],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'voice.invalid_request_body' });
    await app.close();
  });
});
