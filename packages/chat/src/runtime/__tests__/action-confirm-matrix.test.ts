import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { createTestContext } from '@plumbus/core/testing';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  defineCapability,
  executeCapability,
} from '@plumbus/core';
import type { ExecutionContext } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import { capabilityActionHashV2 } from '../../policy/action-schema-hash.js';
import { actionGuard } from '../../policy/action-guard.js';
import { chatConfirmAction } from '../../capabilities/chat-confirm-action.js';
import { chatPendingActionRepo } from '../../internal/chat-repos.js';
import { createSession } from '../../session/service.js';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';

function ctxWithRegistry(registry: CapabilityRegistry): ExecutionContext {
  const base = createTestContext();
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
    id: '00000000-0000-4000-8000-000000000002',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: { orderId: 'o-1' },
    inputSchemaHash: 'hash-a',
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship order?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

describe('C6 action-confirm matrix', () => {
  it('uses real core describe + v2 hash binding at claim time', async () => {
    const cap = defineCapability({
      name: 'ship',
      kind: 'action',
      domain: 'orders',
      input: z.object({ orderId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });

    const registry = new CapabilityRegistry();
    registry.register(cap);
    const ctx = ctxWithRegistry(registry);

    const described = ctx.capabilities.describe?.('orders.ship');
    expect(described).toBeDefined();
    const hash = capabilityActionHashV2(described?.inputSchema ?? {}, { orderId: 'o-1' });

    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await chatPendingActionRepo(ctx).create(
      pendingRow(session.id, { inputSchemaHash: hash, toolBindingHash: hash }),
    );

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: '00000000-0000-4000-8000-000000000002',
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: hash,
      toolBindingHash: hash,
      execute: true,
    });
    expect(result.success).toBe(true);
  });

  it('action-guard blocks when pending cap excludes expired rows', async () => {
    const ctx = ctxWithRegistry(new CapabilityRegistry());
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await chatPendingActionRepo(ctx).create(
      pendingRow(session.id, {
        id: '00000000-0000-4000-8000-000000000010',
        capabilityName: 'testAction',
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );

    const verdict = await actionGuard(
      {
        sessionId: session.id,
        userId: ctx.auth.userId ?? 'test-user',
        ordinal: 0,
        audience: 'user',
        locale: 'en',
      },
      {
        ctx,
        chatName: 'help',
        policy: {},
        resolvedSources: new Set(),
        saveToDb: true,
        budgetActionsPerSession: 1,
        modelOutput: {
          requestedAction: {
            capabilityName: 'testAction',
            input: {},
            confirmationMessage: 'new',
          },
        },
      },
    );

    expect(verdict.decision).toBe('require_confirmation');
  });

  it('claim rejects binding mismatch with chat.binding_changed', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(pendingRow(session.id));

    const result = await executeCapability(chatConfirmAction, ctx, {
      actionId: '00000000-0000-4000-8000-000000000002',
      chatName: 'help',
      decision: 'confirm',
      inputSchemaHash: 'wrong-echo',
      toolBindingHash: 'bind-a',
      execute: false,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error?.metadata?.code).toBe('chat.binding_changed');
    }
  });
});
