import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import { chatSessionRepo } from '../../internal/chat-repos.js';
import { registerChatRoutes } from '../http.js';

const inScopeResponse = {
  inScope: true,
  answer: 'ok',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
};

function depsFromContext(ctx: ReturnType<typeof createTestContext>) {
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
}

describe('registerChatRoutes', () => {
  it('returns JSON events when streaming is false', async () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'jsonChat',
      access: {},
      streaming: false,
      instructions: ['help'],
    });

    const sharedCtx = createTestContext({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const now = sharedCtx.time.now();
    await chatSessionRepo(sharedCtx).create({
      id: sessionId,
      chatName: 'jsonChat',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
      startedAt: now,
      lastTurnAt: now,
      status: 'active',
      behavioralState: {},
      summaryTurnCount: 0,
    });

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
        createDependencies: () => depsFromContext(sharedCtx),
      } as never,
      [chat],
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/jsonChat/turn',
      headers: { authorization: 'Bearer test' },
      payload: {
        sessionId,
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
        projectId: 'proj-1',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = res.json() as { events: Array<{ type: string }> };
    expect(body.events.some((e) => e.type === 'turn.completed')).toBe(true);

    await app.close();
  });

  it('runs beforeTurn prefix and afterTurn side effect', async () => {
    const app = Fastify();
    let counter = 0;
    const chat = defineChat({
      name: 'hookChat',
      access: {},
      streaming: false,
      instructions: ['help'],
    });

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
        createDependencies: () => {
          const ctx = createTestContext();
          return {
            auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
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
      } as never,
      [chat],
      {
        beforeTurn: async (_ctx, parsed) => ({
          userMessage: `PREFIX:${parsed.userMessage}`,
        }),
        afterTurn: async () => {
          counter++;
        },
      },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/hookChat/turn',
      headers: { authorization: 'Bearer test' },
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000002',
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(counter).toBe(1);
    await app.close();
  });

  it('authenticates via cookie when Authorization header is absent', async () => {
    const app = Fastify();
    const authenticate = vi.fn(async (token?: string) => {
      if (token === 'Bearer cookie-token') {
        return { userId: 'admin', roles: ['admin'], scopes: [], provider: 'test' };
      }
      return null;
    });

    const chat = defineChat({ name: 'cookieChat', access: {}, streaming: false });

    registerChatRoutes(
      app,
      {
        authAdapter: { authenticate },
        createDependencies: () => {
          const ctx = createTestContext();
          return {
            auth: { userId: 'admin', roles: ['admin'], scopes: [], provider: 'test' },
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
      } as never,
      [chat],
      { authCookieNames: ['admin_auth_token'] },
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/cookieChat/turn',
      headers: { cookie: 'admin_auth_token=cookie-token' },
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000003',
        userMessage: 'hi',
        audience: 'admin',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith('Bearer cookie-token');
    await app.close();
  });

  it('returns 403 when chat access policy denies the caller', async () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'adminOnly',
      access: { roles: ['admin'] },
      streaming: false,
      instructions: ['help'],
    });

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
        createDependencies: () => depsFromContext(createTestContext()),
      } as never,
      [chat],
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/adminOnly/turn',
      headers: { authorization: 'Bearer test' },
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000010',
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('allows admin when chat access policy requires admin role', async () => {
    const app = Fastify();
    const chat = defineChat({
      name: 'adminOnlyOk',
      access: { roles: ['admin'] },
      streaming: false,
      instructions: ['help'],
    });
    const sharedCtx = createTestContext({
      auth: { userId: 'admin-1', roles: ['admin'], scopes: [], provider: 'test' },
      ai: mockAI({ generate: inScopeResponse }),
    });
    const sessionId = '00000000-0000-4000-8000-000000000011';
    const now = sharedCtx.time.now();
    await chatSessionRepo(sharedCtx).create({
      id: sessionId,
      chatName: 'adminOnlyOk',
      userId: 'admin-1',
      audience: 'user',
      locale: 'en',
      startedAt: now,
      lastTurnAt: now,
      status: 'active',
      behavioralState: {},
      summaryTurnCount: 0,
    });

    registerChatRoutes(
      app,
      {
        authAdapter: {
          authenticate: async () => ({
            userId: 'admin-1',
            roles: ['admin'],
            scopes: [],
            provider: 'test',
          }),
        },
        createDependencies: () => depsFromContext(sharedCtx),
      } as never,
      [chat],
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/adminOnlyOk/turn',
      headers: { authorization: 'Bearer test' },
      payload: {
        sessionId,
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns 401 when authentication fails', async () => {
    const app = Fastify();
    const chat = defineChat({ name: 'help', access: {}, streaming: false, instructions: ['x'] });

    registerChatRoutes(
      app,
      {
        authAdapter: { authenticate: async () => null },
        createDependencies: () => depsFromContext(createTestContext()),
      } as never,
      [chat],
    );

    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/help/turn',
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000099',
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
