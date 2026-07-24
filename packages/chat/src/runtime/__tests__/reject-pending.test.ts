import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
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
    toolName: 'test',
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
    id: '00000000-0000-4000-8000-000000000020',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'testAction',
    input: {},
    inputSchemaHash: 'legacy',
    toolBindingHash: 'legacy',
    confirmationMessage: 'confirm?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

describe('rejectPending idempotency', () => {
  it('returns already_terminal when row is already rejected', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await chatPendingActionRepo(ctx).create(pending(session.id, { status: 'rejected' }));

    await expect(
      rejectPending(ctx, {
        actionId: '00000000-0000-4000-8000-000000000020',
        ownerUserId: ctx.auth.userId ?? 'test-user',
        sessionUserId: session.userId,
      }),
    ).resolves.toEqual({ rejected: false, reason: 'already_terminal' });
  });

  it('returns not_found when row is missing', async () => {
    const ctx = createTestContext();
    await expect(
      rejectPending(ctx, {
        actionId: '00000000-0000-4000-8000-000000000099',
        ownerUserId: ctx.auth.userId ?? 'test-user',
        sessionUserId: 'test-user',
      }),
    ).resolves.toEqual({ rejected: false, reason: 'not_found' });
  });
});
