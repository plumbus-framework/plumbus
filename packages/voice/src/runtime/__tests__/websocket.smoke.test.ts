import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import WebSocket from 'ws';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { registerVoiceRoutes } from '../http.js';
import { pcmSampleFrames } from '../../testing/index.js';

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

describe('voice websocket smoke', () => {
  const apps: Awaited<ReturnType<typeof Fastify>>[] = [];

  afterEach(async () => {
    while (apps.length > 0) {
      await apps.pop()?.close();
    }
  });

  it('accepts a valid session token and completes one websocket turn', async () => {
    const app = Fastify();
    apps.push(app);

    const voice = defineVoice({
      name: 'socketVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts', locale: 'en-US', voiceId: 'browser-default' },
      brain: {
        async run() {
          return { text: 'Hello back from the websocket runtime.' };
        },
      },
    });

    registerVoiceRoutes(
      app,
      {
        db: null as never,
        authAdapter: {
          authenticate: async (header?: string) =>
            header === 'Bearer user-token'
              ? { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' }
              : null,
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: { providers: { 'web-speech': {}, 'browser-tts': {}, websocket: {} } },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
        websocketOriginAllowlist: ['https://voice.test'],
      },
    );

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine test server address');
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const sessionRes = await fetch(`${baseUrl}/api/voice/socketVoice/session`, {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { wsUrl: string; sessionToken: string };

    const frames = await new Promise<{ texts: string[]; binaryCount: number }>(
      (resolve, reject) => {
        const texts: string[] = [];
        let binaryCount = 0;
        const socket = new WebSocket(session.wsUrl, [`voice-session.${session.sessionToken}`], {
          origin: 'https://voice.test',
        });

        socket.once('open', () => {
          socket.send(pcmSampleFrames.silent16kMono);
          socket.send(JSON.stringify({ type: 'stt.final', text: 'hello voice', language: 'en' }));
          socket.send(JSON.stringify({ type: 'ptt.up', language: 'en' }));
        });

        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            binaryCount += 1;
          } else {
            texts.push(data.toString());
          }

          if (
            texts.some((frame) => frame.includes('"type":"session.hello"')) &&
            texts.some((frame) => frame.includes('"type":"turn.completed"'))
          ) {
            socket.close();
            resolve({ texts, binaryCount });
          }
        });

        socket.once('error', reject);
      },
    );

    expect(frames.texts.some((frame) => frame.includes('"type":"session.hello"'))).toBe(true);
    expect(frames.texts.some((frame) => frame.includes('"type":"turn.completed"'))).toBe(true);
    expect(frames.binaryCount).toBe(0);
  });

  it('rejects an invalid websocket session token', async () => {
    const app = Fastify();
    apps.push(app);

    const voice = defineVoice({
      name: 'socketVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'web-speech' },
      tts: { provider: 'browser-tts' },
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
          authenticate: async (header?: string) =>
            header === 'Bearer user-token'
              ? { userId: 'user-1', roles: ['user'], scopes: [], provider: 'test' }
              : null,
        },
        createDependencies: (auth) => depsFromAuth(auth),
      },
      [voice],
      {
        providers: { providers: { 'web-speech': {}, 'browser-tts': {}, websocket: {} } },
        sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
        websocketOriginAllowlist: ['https://voice.test'],
      },
    );

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to determine test server address');
    }

    const wsUrl = `ws://127.0.0.1:${address.port}/api/voice/socketVoice/stream`;
    const outcome = await new Promise<string>((resolve, reject) => {
      const socket = new WebSocket(wsUrl, ['voice-session.invalid-token'], {
        origin: 'https://voice.test',
      });

      socket.on('message', (data, isBinary) => {
        if (!isBinary) {
          resolve(data.toString());
          socket.close();
        }
      });
      socket.once('close', () => resolve('closed'));
      socket.once('error', reject);
    });

    expect(outcome === 'closed' || outcome.includes('voice.unauthorized')).toBe(true);
  });
});
