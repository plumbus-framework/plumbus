import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { AIService, AuthContext } from '@plumbus/core';
import { PlumbusError } from '@plumbus/core';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import { createInMemoryChatSessionStore } from '../../session/in-memory-session-store.js';
import { createInMemoryChatConversationStore } from '../in-memory-conversation-store.js';
import type { ChatEvent } from '../../types/event.js';
import { type RegisterChatRoutesOpts, registerChatRoutes } from '../http.js';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const answer = {
  inScope: true,
  answer: 'Draft.',
  refusalReason: null,
  citedSources: [],
  requestedAction: null,
};

function depsFor(auth: AuthContext, ai: AIService) {
  const ctx = createTestContext({ auth, ai });
  return {
    auth,
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

interface Setup {
  /** What the credential claims. */
  tokenAuth?: Partial<AuthContext>;
  tenantScoped?: boolean;
  routeConfig?: Record<string, unknown>;
  opts?: RegisterChatRoutesOpts;
  ai?: AIService;
}

async function turn(setup: Setup, headers: Record<string, string> = {}) {
  const app = Fastify();
  const ai = setup.ai ?? mockAI({ generate: answer });
  const seenAuth: AuthContext[] = [];
  const chat = defineChat({
    name: 'seam',
    access: setup.tenantScoped ? { tenantScoped: true } : {},
    streaming: false,
    instructions: ['x'],
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
          ...(setup.tokenAuth ?? {}),
        }),
      },
      createDependencies: (auth: AuthContext) => {
        seenAuth.push(auth);
        return depsFor(auth, ai);
      },
      ...(setup.routeConfig ?? {}),
    } as never,
    [chat],
    { sessionStore: createInMemoryChatSessionStore(), ...(setup.opts ?? {}) },
  );
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/chat/seam/turn',
    headers: { authorization: 'Bearer t', ...headers },
    payload: {
      sessionId: SESSION_ID,
      userMessage: 'hi',
      audience: 'user',
      locale: 'en',
      tenantId: 'from-body',
    },
  });
  await app.close();
  return { res, seenAuth };
}

describe('registerChatRoutes — request-context seam', () => {
  it('without a seam a tenant-scoped chat refuses a caller without a tenant (unchanged)', async () => {
    const { res } = await turn({ tenantScoped: true });
    expect(res.statusCode).toBe(403);
  });

  it('bindTenant binds the tenant from the request (hostname), replacing the token claim', async () => {
    const { res, seenAuth } = await turn(
      {
        tenantScoped: true,
        tokenAuth: { tenantId: 'claimed' },
        opts: {
          requestContext: {
            bindTenant: async ({ request }) => ({
              tenantId: request.hostname === 'college-a.example' ? 'tenant-a' : undefined,
            }),
          },
        },
      },
      { host: 'college-a.example' },
    );
    expect(res.statusCode).toBe(200);
    expect(seenAuth[0]?.tenantId).toBe('tenant-a');
  });

  it('bindTenant clearing the tenant makes a tenant-scoped chat refuse', async () => {
    const { res } = await turn(
      {
        tenantScoped: true,
        tokenAuth: { tenantId: 'claimed' },
        opts: { requestContext: { bindTenant: async () => ({ tenantId: undefined }) } },
      },
      { host: 'unknown.example' },
    );
    expect(res.statusCode).toBe(403);
  });

  it('bindTenant may refuse outright, and a thrown PlumbusError keeps its status', async () => {
    const refused = await turn({
      opts: {
        requestContext: {
          bindTenant: async () => ({
            refuse: { status: 421, body: { error: { code: 'app.mismatch' } } },
          }),
        },
      },
    });
    expect(refused.res.statusCode).toBe(421);
    expect(refused.res.json()).toEqual({ error: { code: 'app.mismatch' } });

    const thrown = await turn({
      opts: {
        requestContext: {
          bindTenant: async () => {
            throw new PlumbusError('forbidden', 'session and hostname disagree');
          },
        },
      },
    });
    expect(thrown.res.statusCode).toBe(403);
  });

  it('with bindTenant, audienceTenantOverride is not applied', async () => {
    const { seenAuth } = await turn({
      opts: {
        audienceTenantOverride: () => 'from-audience',
        requestContext: { bindTenant: async () => ({ tenantId: undefined }) },
      },
    });
    expect(seenAuth[0]?.tenantId).toBeUndefined();
  });

  it("dependencies: 'route-config' builds the context through resolveDependencies and checks access after it", async () => {
    const ai = mockAI({ generate: answer });
    const calls: Array<{ bypassTenantScope?: boolean }> = [];
    const { res } = await turn({
      tenantScoped: true,
      ai,
      routeConfig: {
        resolveDependencies: async (
          auth: AuthContext,
          options?: { bypassTenantScope?: boolean },
        ) => {
          calls.push(options ?? {});
          // The app's resolver binds the tenant (e.g. from the hostname), as capability routes do.
          auth.tenantId = 'bound-by-resolver';
          return { dependencies: depsFor(auth, ai), db: {} };
        },
      },
      opts: { requestContext: { dependencies: 'route-config' } },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toEqual([{ bypassTenantScope: false }]);
  });

  it("dependencies: 'route-config' maps a resolver refusal to its status", async () => {
    const { res } = await turn({
      routeConfig: {
        resolveDependencies: async () => {
          throw new PlumbusError('unauthorized', 'session revoked');
        },
      },
      opts: { requestContext: { dependencies: 'route-config' } },
    });
    expect(res.statusCode).toBe(401);
  });

  it('checkSession false refuses with 401 chat.session_not_live before any model call', async () => {
    let modelCalls = 0;
    const base = mockAI({ generate: answer });
    const ai: AIService = {
      ...base,
      async *streamGenerate(cfg) {
        modelCalls++;
        yield* base.streamGenerate(cfg);
      },
    };
    const { res } = await turn({
      ai,
      opts: { requestContext: { checkSession: async () => false } },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: 'chat.session_not_live' } });
    expect(modelCalls).toBe(0);
  });

  it('checkSession true lets the turn run', async () => {
    const { res } = await turn({ opts: { requestContext: { checkSession: async () => true } } });
    expect(res.statusCode).toBe(200);
  });

  it('prepareTurn fills promptInput per turn; body fields never reach the prompt', async () => {
    const inputs: Record<string, unknown>[] = [];
    const base = mockAI({ generate: answer });
    const ai: AIService = {
      ...base,
      async *streamGenerate(cfg) {
        inputs.push(cfg.input as Record<string, unknown>);
        yield* base.streamGenerate(cfg);
      },
    };
    const { res } = await turn({
      ai,
      opts: {
        prepareTurn: async ({ ctx }) => ({
          promptInput: { lesson: 'L2', caller: ctx.auth.userId },
        }),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(inputs[0]).toMatchObject({ lesson: 'L2', caller: 'u1' });
    expect(inputs[0]).not.toHaveProperty('tenantId');
  });

  it('prepareTurn can refuse', async () => {
    const { res } = await turn({
      opts: { prepareTurn: async () => ({ error: { status: 429, body: { code: 'app.limit' } } }) },
    });
    expect(res.statusCode).toBe(429);
  });

  it('route-level validateReply replaces the reply; a per-turn validator from prepareTurn wins', async () => {
    const routeLevel = await turn({
      opts: { validateReply: () => ({ decision: 'replace', text: 'Route.', code: 'app.route' }) },
    });
    const events = (routeLevel.res.json() as { events: ChatEvent[] }).events;
    expect(events).toContainEqual({ type: 'message.replaced', text: 'Route.', code: 'app.route' });

    const perTurn = await turn({
      opts: {
        validateReply: () => ({ decision: 'replace', text: 'Route.', code: 'app.route' }),
        prepareTurn: async () => ({
          validateReply: () => ({ decision: 'replace', text: 'Turn.', code: 'app.turn' }),
        }),
      },
    });
    const perTurnEvents = (perTurn.res.json() as { events: ChatEvent[] }).events;
    expect(perTurnEvents).toContainEqual({
      type: 'message.replaced',
      text: 'Turn.',
      code: 'app.turn',
    });
  });

  it('the /confirm route runs the same seam (tenant binding, liveness)', async () => {
    const confirm = async (opts: RegisterChatRoutesOpts) => {
      const app = Fastify();
      const ai = mockAI({ generate: answer });
      registerChatRoutes(
        app,
        {
          authAdapter: {
            authenticate: async () => ({
              userId: 'u1',
              roles: ['user'],
              scopes: [],
              provider: 't',
            }),
          },
          createDependencies: (auth: AuthContext) => depsFor(auth, ai),
        } as never,
        [defineChat({ name: 'seam', access: {}, streaming: false, instructions: ['x'] })],
        { store: createInMemoryChatConversationStore({ sessions: [] }), ...opts },
      );
      await app.ready();
      const res = await app.inject({
        method: 'POST',
        url: '/chat/seam/confirm',
        headers: { authorization: 'Bearer t' },
        payload: {
          actionId: '66666666-6666-4666-8666-666666666666',
          inputSchemaHash: 'h',
          decision: 'reject',
        },
      });
      await app.close();
      return res;
    };
    expect(
      (await confirm({ requestContext: { checkSession: async () => false } })).statusCode,
    ).toBe(401);
    expect(
      (
        await confirm({
          requestContext: {
            bindTenant: async () => ({ refuse: { status: 421, body: { error: 'x' } } }),
          },
        })
      ).statusCode,
    ).toBe(421);
    // Without the seam the unknown action is simply not found.
    expect((await confirm({})).statusCode).toBe(404);
  });
});
