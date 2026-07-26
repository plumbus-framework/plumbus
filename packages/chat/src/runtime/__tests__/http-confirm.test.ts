import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { zodToProviderJsonSchema } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { capabilityInputSchemaHashV2 } from '../../policy/action-schema-hash.js';
import { CapabilityRegistry, buildCapabilityRuntimeDeps, defineCapability } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import type { ChatPendingActionV2 } from '../../session/pending-action-v2.js';
import type { ChatConversationStore } from '../chat-conversation-store.js';
import { CHAT_CSRF_HEADER_NAME, issueCsrfToken, csrfBindingFromAuth } from '../csrf.js';
import { registerChatRoutes } from '../http.js';

const shipInput = z.object({ orderId: z.string() });
const { schema: shipSchema } = zodToProviderJsonSchema(shipInput, { promptName: 'orders.ship' });
const inputSchemaHash = capabilityInputSchemaHashV2(shipSchema);

const actionId = '00000000-0000-4000-8000-000000000201';
const expiresAt = new Date(Date.now() + 60_000).toISOString();

function pendingRow(overrides: Partial<ChatPendingActionV2> = {}): ChatPendingActionV2 {
  return {
    version: 2,
    id: actionId,
    sessionId: '00000000-0000-4000-8000-000000000200',
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: { orderId: 'o-1' },
    inputSchemaHash,
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship?',
    status: 'pending',
    expiresAt,
    resumePayload: {
      version: 1,
      chatName: 'confirmChat',
      logicalTurnId: 'lt-1',
      proposalAssistantTurnId: 'lt-1',
      toolCallId: 'tc-1',
      toolName: 'orders.ship',
      messages: [{ role: 'user', content: 'go' }],
      counters: {
        toolRoundsUsed: 0,
        flowStartsUsed: 0,
        flowAwaitMsUsed: 0,
        inputTokensUsed: 0,
        outputTokensUsed: 0,
        costUsed: 0,
      },
      toolsExecuted: [],
      sourceRefs: [],
    },
    ...overrides,
  };
}

function fakeStore(overrides: Partial<ChatConversationStore> = {}): ChatConversationStore {
  return {
    acquireSessionMutation: vi.fn(),
    renewSessionMutation: vi.fn(),
    releaseSessionMutation: vi.fn(),
    commitTurn: vi.fn(),
    commitProposal: vi.fn(),
    claimPending: vi.fn(),
    markExecutionStarted: vi.fn(),
    completePending: vi.fn(),
    inspectSession: vi.fn(async () => ({ pending: 'none' as const })),
    peekPending: vi.fn(async () => ({ found: false as const })),
    rejectPending: vi.fn(async () => ({ outcome: 'not_found' as const })),
    commitResumeProposal: vi.fn(),
    ...overrides,
  };
}

function routeConfig(sharedCtx: ReturnType<typeof createTestContext>) {
  const cap = defineCapability({
    name: 'ship',
    kind: 'action',
    domain: 'orders',
    access: {},
    input: z.object({ orderId: z.string() }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });
  const registry = new CapabilityRegistry();
  registry.register(cap);
  const runtimeDeps = buildCapabilityRuntimeDeps(registry);
  return {
    authAdapter: {
      authenticate: async (token?: string) => {
        if (token === 'Bearer good' || token === 'good') {
          return { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' };
        }
        return null;
      },
    },
    createDependencies: () => ({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
      data: sharedCtx.data,
      events: sharedCtx.events,
      flows: sharedCtx.flows,
      ai: sharedCtx.ai,
      audit: sharedCtx.audit,
      logger: sharedCtx.logger,
      time: sharedCtx.time,
      config: sharedCtx.config,
      security: sharedCtx.security,
      translations: sharedCtx.translations,
      ...runtimeDeps,
    }),
  } as never;
}

describe('POST /chat/:name/confirm', () => {
  const chat = defineChat({
    name: 'confirmChat',
    access: {},
    streaming: false,
    instructions: ['help'],
  });

  it('returns 401 when authentication fails', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore(),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('returns 400 on an invalid confirm body', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore(),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 404 chat.action_not_found when peek reports owner-miss', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({ peekPending: vi.fn(async () => ({ found: false as const })) }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'chat.action_not_found', actionId });
    await app.close();
  });

  it('returns 409 chat.action_already_claimed with {code,actionId,expiresAt} when claim loses', async () => {
    const row = pendingRow();
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        peekPending: vi.fn(async () => ({ found: true as const, pending: row })),
        claimPending: vi.fn(async () => ({ outcome: 'already_claimed' as const })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: 'chat.action_already_claimed',
      actionId,
      expiresAt,
    });
    await app.close();
  });

  it('returns 409 chat.confirm_stale on revision drift', async () => {
    const row = pendingRow();
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        peekPending: vi.fn(async () => ({ found: true as const, pending: row })),
        claimPending: vi.fn(async () => ({ outcome: 'stale' as const })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'chat.confirm_stale', actionId, expiresAt });
    await app.close();
  });

  it('returns 409 chat.binding_changed on hash mismatch', async () => {
    const row = pendingRow();
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        peekPending: vi.fn(async () => ({ found: true as const, pending: row })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash: 'wrong-hash', decision: 'confirm' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'chat.binding_changed', actionId, expiresAt });
    await app.close();
  });

  it('returns 410 chat.action_expired when peek reports expiry', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        peekPending: vi.fn(async () => ({ found: false as const, reason: 'expired' as const })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'chat.action_expired', actionId });
    await app.close();
  });

  it('returns 410 chat.action_expired when claim reports expired', async () => {
    const row = pendingRow();
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        peekPending: vi.fn(async () => ({ found: true as const, pending: row })),
        claimPending: vi.fn(async () => ({ outcome: 'expired' as const })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toMatchObject({ code: 'chat.action_expired', actionId });
    await app.close();
  });

  it('rejects a cookie-auth confirm with 403 chat.origin_invalid when Origin/CSRF are missing', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore(),
      authCookieNames: ['session'],
      csrfSecret: 'csrf-secret',
      externalBaseUrl: 'https://app.example.com',
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { cookie: 'session=good' },
      payload: { actionId, inputSchemaHash, decision: 'confirm' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: { code: 'chat.origin_invalid' } });
    await app.close();
  });

  it('reject decision terminalizes and returns confirmation.resolved rejected', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        rejectPending: vi.fn(async () => ({
          outcome: 'rejected' as const,
          capabilityName: 'orders.ship',
        })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: { authorization: 'Bearer good' },
      payload: { actionId, inputSchemaHash, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      events: Array<{ type: string; pendingStatus?: string }>;
      result: { pendingStatus: string };
    };
    expect(body.events[0]).toMatchObject({
      type: 'confirmation.resolved',
      pendingStatus: 'rejected',
    });
    expect(body.result.pendingStatus).toBe('rejected');
    await app.close();
  });

  it('/turn returns 409 chat.pending_action_exists when store.inspectSession reports a live pending', async () => {
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        inspectSession: vi.fn(async () => ({
          pending: 'pending' as const,
          actionId,
          expiresAt,
        })),
      }),
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/turn',
      headers: { authorization: 'Bearer good' },
      payload: {
        sessionId: '00000000-0000-4000-8000-000000000200',
        userMessage: 'hi',
        audience: 'user',
        locale: 'en',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ code: 'chat.pending_action_exists', actionId, expiresAt });
    await app.close();
  });

  it('accepts cookie auth with valid Origin and CSRF header', async () => {
    const secret = 'csrf-secret';
    const auth = { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' };
    const token = issueCsrfToken(secret, csrfBindingFromAuth(auth));
    const app = Fastify();
    registerChatRoutes(app, routeConfig(createTestContext()), [chat], {
      store: fakeStore({
        rejectPending: vi.fn(async () => ({
          outcome: 'rejected' as const,
          capabilityName: 'orders.ship',
        })),
      }),
      authCookieNames: ['session'],
      csrfSecret: secret,
      externalBaseUrl: 'https://app.example.com',
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/chat/confirmChat/confirm',
      headers: {
        cookie: 'session=good',
        origin: 'https://app.example.com',
        [CHAT_CSRF_HEADER_NAME]: token,
      },
      payload: { actionId, inputSchemaHash, decision: 'reject' },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
