import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  createExecutionContext,
} from '@plumbus/core';
import { rejectPending } from '../pending-actions.js';
import { chatPendingActionRepo } from '../../internal/chat-repos.js';
import { createSession } from '../../session/service.js';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';

function minimalResume(): ChatToolResumePayloadV1 {
  return {
    version: 1,
    chatName: 'help',
    logicalTurnId: 'lt-1',
    proposalAssistantTurnId: 'lt-1',
    toolCallId: 'tc-1',
    toolName: 'orders.ship',
    messages: [{ role: 'user', content: 'x' }],
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

function pending(
  sessionId: string,
  overrides: Partial<ChatPendingActionV2> = {},
): ChatPendingActionV2 {
  return {
    version: 2,
    id: '00000000-0000-4000-8000-000000000040',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: {},
    inputSchemaHash: 'legacy',
    toolBindingHash: 'legacy',
    confirmationMessage: 'Ship?',
    status: 'pending',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

describe('pending-actions ownership guards', () => {
  it('rejectPending returns not_found for foreign-user rows', async () => {
    const ownerCtx = createTestContext({
      auth: { userId: 'owner', roles: [], scopes: [], provider: 'test' },
    });
    const session = await createSession(ownerCtx, {
      chatName: 'help',
      userId: 'owner',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ownerCtx).create(pending(session.id));

    const attacker = createExecutionContext({
      auth: { userId: 'attacker', roles: [], scopes: [], provider: 'test' },
      data: ownerCtx.data,
      events: ownerCtx.events,
      audit: ownerCtx.audit,
      logger: ownerCtx.logger,
      time: ownerCtx.time,
      ...buildCapabilityRuntimeDeps(new CapabilityRegistry()),
    });

    await expect(
      rejectPending(attacker, {
        actionId: '00000000-0000-4000-8000-000000000040',
        ownerUserId: 'attacker',
        sessionUserId: session.userId,
      }),
    ).resolves.toEqual({ rejected: false, reason: 'not_found' });

    const row = await ownerCtx.data.ChatPendingAction?.findById(
      '00000000-0000-4000-8000-000000000040',
    );
    expect(row?.status).toBe('pending');
  });

  it('rejectPending returns rejected:true with capabilityName for owners', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        id: '00000000-0000-4000-8000-000000000041',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    await expect(
      rejectPending(ctx, {
        actionId: '00000000-0000-4000-8000-000000000041',
        ownerUserId: ctx.auth.userId ?? 'u1',
        sessionUserId: session.userId,
      }),
    ).resolves.toEqual({ rejected: true, capabilityName: 'orders.ship' });
  });
});
