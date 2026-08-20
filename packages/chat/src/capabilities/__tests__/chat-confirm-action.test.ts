import { describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  defineCapability,
  executeCapability,
} from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import { createTestContext, mockEvents } from '@plumbus/core/testing';
import { chatConfirmAction } from '../chat-confirm-action.js';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';
import { createSession } from '../../session/service.js';

function minimalResume(): ChatToolResumePayloadV1 {
  return {
    version: 1,
    chatName: 'help',
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
  };
}

function pendingRow(
  sessionId: string,
  overrides: Partial<ChatPendingActionV2> = {},
): ChatPendingActionV2 {
  return {
    version: 2,
    id: '00000000-0000-4000-8000-000000000301',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: { orderId: 'stored-o-1', priority: 1 },
    inputSchemaHash: 'hash-a',
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

function ctxWithCaps(
  caps: ReturnType<typeof defineCapability>[],
  shared?: ReturnType<typeof createTestContext>,
) {
  const base = shared ?? createTestContext();
  const registry = new CapabilityRegistry();
  for (const cap of caps) registry.register(cap);
  return createExecutionContext({
    auth: base.auth,
    data: base.data,
    events: base.events,
    audit: base.audit,
    logger: base.logger,
    time: base.time,
    ...buildCapabilityRuntimeDeps(registry),
  });
}

describe('chatConfirmAction', () => {
  it('confirm executes the capability through executeCapability using stored normalized input, not client input', async () => {
    let received: unknown;
    const shipCap = defineCapability({
      name: 'ship',
      kind: 'action',
      domain: 'orders',
      input: z.object({ orderId: z.string(), priority: z.number().default(1) }),
      output: z.object({ ok: z.boolean() }),
      access: {},
      effects: { data: [], events: [], external: [], ai: false },
      handler: async (_ctx, input) => {
        received = input;
        return { ok: true };
      },
    });

    const base = createTestContext();
    const ctx = ctxWithCaps([shipCap], base);
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id);
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionStatus).toBe('succeeded');
      expect(received).toEqual({ orderId: 'stored-o-1', priority: 1 });
    }
  });

  it('renews the session lease while a long-running capability executes (so the reaper does not reap it)', async () => {
    vi.useFakeTimers();
    try {
      let releaseCap: (() => void) | undefined;
      const gate = new Promise<void>((resolve) => {
        releaseCap = resolve;
      });
      const slowCap = defineCapability({
        name: 'ship',
        kind: 'action',
        domain: 'orders',
        input: z.object({ orderId: z.string(), priority: z.number().default(1) }),
        output: z.object({ ok: z.boolean() }),
        access: {},
        effects: { data: [], events: [], external: [], ai: false },
        handler: async () => {
          await gate;
          return { ok: true };
        },
      });

      const base = createTestContext();
      const ctx = ctxWithCaps([slowCap], base);

      // Count lease RENEWALS: a renew is an updateWhere on ChatSession whose updates set
      // leaseExpiresAt without touching leaseToken (acquire/release both set leaseToken).
      const sessionsRepo = (ctx.data as Record<string, { updateWhere?: unknown }>).ChatSession as {
        updateWhere: (id: string, predicate: unknown, updates: Record<string, unknown>) => unknown;
      };
      const origUpdateWhere = sessionsRepo.updateWhere.bind(sessionsRepo);
      let renewals = 0;
      sessionsRepo.updateWhere = (id, predicate, updates) => {
        if (updates && 'leaseExpiresAt' in updates && !('leaseToken' in updates)) renewals += 1;
        return origUpdateWhere(id, predicate, updates);
      };

      const session = await createSession(ctx, {
        chatName: 'help',
        userId: ctx.auth.userId ?? 'u1',
        audience: 'user',
        locale: 'en',
      });
      const pending = pendingRow(session.id);
      await ctx.data.ChatPendingAction?.create(pending);

      const resultPromise = executeCapability(chatConfirmAction, ctx, {
        actionId: pending.id,
        chatName: 'help',
        decision: 'confirm',
        inputSchemaHash: 'hash-a',
        toolBindingHash: 'bind-a',
        execute: true,
      });

      // Advance past a 15s renewal interval while executeCapability is still blocked.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(renewals).toBeGreaterThanOrEqual(1);

      releaseCap?.();
      const result = await resultPromise;
      expect(result.success).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('confirm with execute:false records decision-only (executionStatus not_requested, pendingStatus confirmed)', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id);
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: false,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.executionStatus).toBe('not_requested');
      expect(result.data.pendingStatus).toBe('confirmed');
    }
  });

  it('confirm maps access-denied to chat.tool_access_denied and marks pending failed', async () => {
    const deniedCap = defineCapability({
      name: 'ship',
      kind: 'action',
      domain: 'orders',
      input: z.object({ orderId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      access: { roles: ['admin'] },
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });

    const base = createTestContext({
      auth: { userId: 'u1', roles: ['user'], scopes: [], provider: 'test' },
    });
    const ctx = ctxWithCaps([deniedCap], base);
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id, { input: { orderId: 'o-1' } });
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingStatus).toBe('failed');
      const toolFailed = result.data.events.find(
        (e) =>
          typeof e === 'object' && e !== null && (e as { type?: string }).type === 'tool.failed',
      ) as { code?: string } | undefined;
      expect(toolFailed?.code).toBe('chat.tool_access_denied');
    }
  });

  it('reject flips pending→rejected once and emits chatActionRejectedEvent', async () => {
    const events = mockEvents();
    const ctx = createTestContext({ events });
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id);
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'reject',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: false,
    });

    expect(result.success).toBe(true);
    expect(ctx.events.emitted.some((e) => e.eventName === 'chat.action.rejected')).toBe(true);
  });

  it('claim losing the race surfaces chat.action_already_claimed', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id, {
      status: 'confirming',
      attemptId: 'other-attempt',
    });
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: false,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.metadata?.code).toBe('chat.action_already_claimed');
    }
  });

  it('non-owner confirm returns chat.action_not_found', async () => {
    const ownerCtx = createTestContext({
      auth: { userId: 'owner', roles: ['user'], scopes: [], provider: 'test' },
    });
    const session = await createSession(ownerCtx, {
      chatName: 'help',
      userId: 'owner',
      audience: 'user',
      locale: 'en',
    });
    const pending = pendingRow(session.id);
    await ownerCtx.data.ChatPendingAction?.create(pending);

    const attacker = createExecutionContext({
      auth: { userId: 'attacker', roles: ['user'], scopes: [], provider: 'test' },
      data: ownerCtx.data,
      events: ownerCtx.events,
      audit: ownerCtx.audit,
      logger: ownerCtx.logger,
      time: ownerCtx.time,
    });

    const result = await executeCapability(chatConfirmAction, attacker, {
      actionId: pending.id,
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      execute: false,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.code).toBe('notFound');
    }
  });
});
