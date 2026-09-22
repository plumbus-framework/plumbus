import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import { registerChatRoutes } from '../http.js';

const inScopeResponse = {
  inScope: true,
  answer: 'ok',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
};

const SESSION_ID = '00000000-0000-4000-8000-0000000000aa';

/** Any property access throws, so a single `ctx.data` reach fails the request. */
function dataTrap(): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(
          `ctx.data was accessed (property "${String(prop)}") — the injected session store path must not touch ctx.data`,
        );
      },
    },
  );
}

function depsWithoutData(ctx: ReturnType<typeof createTestContext>) {
  return {
    auth: ctx.auth,
    data: dataTrap(),
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
}

const routeConfig = (ctx: ReturnType<typeof createTestContext>) =>
  ({
    authAdapter: {
      authenticate: async () => ({
        userId: 'u1',
        roles: ['user'],
        scopes: [],
        provider: 'test',
      }),
    },
    createDependencies: () => depsWithoutData(ctx),
  }) as never;

describe('registerChatRoutes — injected session store', () => {
  it('serves a turn end to end without reading ctx.data', async () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'noDbChat',
      access: {},
      streaming: false,
      instructions: ['help'],
    });
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const sessionStore = createInMemoryChatSessionStore();

    // No `store` (tier 2) — the documented tier-1-only deployment shape.
    registerChatRoutes(app, routeConfig(ctx), [chat], { sessionStore });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/chat/noDbChat/turn',
      headers: { authorization: 'Bearer t' },
      payload: {
        sessionId: SESSION_ID,
        userMessage: 'hello',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string; message?: string }> };
    const types = body.events.map((e) => e.type);
    expect(types).toContain('turn.completed');
    expect(types).not.toContain('turn.failed');

    // The session was bootstrapped in the injected store, not in ctx.data.
    expect(sessionStore.__sessions.get(SESSION_ID)?.chatName).toBe('noDbChat');
    expect(sessionStore.__turns.map((t) => t.content)).toEqual(['hello', 'ok']);
  });

  it('rejects a confirmation-capable chat at registration when no atomic tier is supplied', () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'actionChat',
      access: {},
      streaming: false,
      instructions: ['help'],
      policy: { action: { allowedCapabilities: ['doThing'] } },
    });
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });

    expect(() =>
      registerChatRoutes(app, routeConfig(ctx), [chat], {
        sessionStore: createInMemoryChatSessionStore(),
      }),
    ).toThrowError(/conversation store with atomic writes/);
  });

  it('leaves the DB-backed path untouched when nothing is injected', async () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'dbChat',
      access: {},
      streaming: false,
      instructions: ['help'],
    });
    const ctx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });

    // Real ctx.data this time — the legacy pre-turn pending check must still run.
    registerChatRoutes(
      app,
      {
        authAdapter: {
          authenticate: async () => ({
            userId: 'u1',
            roles: ['user'],
            scopes: [],
            provider: 'test',
          }),
        },
        createDependencies: () => ({
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
        }),
      } as never,
      [chat],
    );
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/chat/dbChat/turn',
      headers: { authorization: 'Bearer t' },
      payload: {
        sessionId: '00000000-0000-4000-8000-0000000000bb',
        userMessage: 'hello',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events.map((e) => e.type)).toContain('turn.completed');
  });
});
