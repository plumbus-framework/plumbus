import { afterAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { E2EServerContext } from '../../../../plumbus-core/src/testing/e2e.js';
import { createE2EServer } from '../../../../plumbus-core/src/testing/e2e.js';
import { createTestContext } from '@plumbus/core/testing';
import { defineVoice } from '../../define/defineVoice.js';
import { createProviderRegistry } from '../../providers/registry.js';
import { registerVoiceRoutes } from '../http.js';
import { createMockSTTProvider, createMockTTSProvider, pcmSampleFrames } from '../../testing/index.js';

describe('voice e2e', () => {
  let server: E2EServerContext | undefined;
  const recordedCosts: Array<{ operation: string }> = [];

  afterAll(async () => {
    if (server) {
      await server.close();
    }
  });

  it('creates a voice session and completes one websocket turn', async () => {
    const registry = createProviderRegistry({
      stt: {
        'openai-whisper': createMockSTTProvider({
          usage() {
            return [{ provider: 'openai-whisper', kind: 'transcribe', quantity: 2, unit: 'seconds' }];
          },
        }),
      },
      tts: {
        openai: createMockTTSProvider({
          async *synthesizeStream(text: string) {
            yield Uint8Array.from(text, (char) => char.charCodeAt(0) & 0xff);
          },
          usage() {
            return [{ provider: 'openai', kind: 'synthesize', quantity: 18, unit: 'characters' }];
          },
        }),
      },
    });

    const voice = defineVoice({
      name: 'testVoice',
      access: {},
      transport: { provider: 'websocket' },
      stt: { provider: 'openai-whisper', model: 'whisper-1' },
      tts: { provider: 'openai', model: 'tts-1', voiceId: 'alloy' },
      brain: {
        async run() {
          return { text: 'E2E voice reply.' };
        },
      },
    });

    server = await createE2EServer({
      authAdapter: {
        authenticate: async (header?: string) =>
          header === 'Bearer user-token'
            ? { userId: 'e2e-user', roles: ['user'], scopes: [], provider: 'test' }
            : null,
      },
      onRoutesRegistered(app, routeConfig) {
        registerVoiceRoutes(
          app,
          {
            ...routeConfig,
            createDependencies: (auth) => {
              const ctx = createTestContext({
                auth: {
                  userId: auth.userId,
                  roles: auth.roles,
                  scopes: auth.scopes ?? [],
                  provider: auth.provider,
                  tenantId: auth.tenantId,
                },
                config: {
                  voiceSessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
                },
              });
              const baseRecord = ctx.ai.recordProviderCost.bind(ctx.ai);
              return {
                auth: ctx.auth,
                data: ctx.data,
                events: ctx.events,
                flows: ctx.flows,
                ai: {
                  ...ctx.ai,
                  async recordProviderCost(entry, costContext) {
                    recordedCosts.push({ operation: entry.operation });
                    await baseRecord(entry, costContext);
                  },
                },
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
                openai: { apiKey: 'openai-key' },
                'openai-whisper': { apiKey: 'openai-key', baseUrl: 'https://api.openai.test/v1' },
                websocket: {},
              },
            },
            registry,
            sessionTokenSecret: 'voice-session-secret-for-tests-1234567890',
            websocketOriginAllowlist: ['https://voice.test'],
          },
        );
      },
    });

    const sessionRes = await server.fetch('/api/voice/testVoice/session', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
    });

    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as { wsUrl: string; sessionToken: string };
    expect(session.wsUrl).toContain('/api/voice/testVoice/stream');
    expect(typeof session.sessionToken).toBe('string');

    const result = await new Promise<{ turnCompleted: boolean; binaryCount: number }>(
      (resolve, reject) => {
        const socket = new WebSocket(session.wsUrl, [`voice-session.${session.sessionToken}`], {
          origin: 'https://voice.test',
        });
        let turnCompleted = false;
        let binaryCount = 0;

        socket.once('open', () => {
          socket.send(pcmSampleFrames.pulse16kMono);
          socket.send(JSON.stringify({ type: 'stt.final', text: 'start interview', language: 'en' }));
          socket.send(JSON.stringify({ type: 'ptt.up', language: 'en' }));
        });

        socket.on('message', (data, isBinary) => {
          if (isBinary) {
            binaryCount += 1;
          } else if (data.toString().includes('"type":"turn.completed"')) {
            turnCompleted = true;
            socket.close();
            resolve({ turnCompleted, binaryCount });
          }
        });

        socket.once('error', reject);
      },
    );

    expect(result.turnCompleted).toBe(true);
    expect(result.binaryCount).toBeGreaterThan(0);
    expect(recordedCosts.map((entry) => entry.operation).sort()).toEqual(['synthesize', 'transcribe']);
  });
});
