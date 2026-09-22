import { describe, expect, it } from 'vitest';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';
import { createInMemoryChatConversationStore } from '../in-memory-conversation-store.js';

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

function pending(sessionId: string): ChatPendingActionV2 {
  return {
    version: 2,
    id: '00000000-0000-4000-8000-000000000201',
    sessionId,
    expectedSessionRevision: 1,
    capabilityName: 'orders.ship',
    input: { orderId: 'o-1' },
    inputSchemaHash: 'hash-a',
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
  };
}

describe('createInMemoryChatConversationStore', () => {
  it('conforms to the store contract: proposal → claim → complete happy path', async () => {
    const store = createInMemoryChatConversationStore({
      sessions: [{ id: 's1', userId: 'u1', chatName: 'help', revision: 0 }],
    });

    const leaseRes = await store.acquireSessionMutation({
      sessionId: 's1',
      ownerToken: 'lease-1',
      leaseMs: 30_000,
    });
    expect(leaseRes.acquired).toBe(true);
    if (!leaseRes.acquired) return;

    const p = pending('s1');
    await store.commitProposal({
      lease: leaseRes.lease,
      expectedRevision: 0,
      userTurn: {
        role: 'user',
        content: 'ship',
        inScope: true,
        sources: [],
        logicalTurnId: 'lt-1',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: '',
        latencyMs: 0,
      },
      assistantTurn: {
        role: 'assistant',
        content: 'Confirm?',
        inScope: true,
        sources: [],
        logicalTurnId: 'lt-1',
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        model: 'm',
        latencyMs: 0,
      },
      pending: p,
    });

    const claim = await store.claimPending({
      actionId: p.id,
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      chatName: 'help',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-1',
      now: new Date().toISOString(),
    });
    expect(claim.outcome).toBe('claimed');

    const done = await store.completePending({
      actionId: p.id,
      attemptId: 'attempt-1',
      lease: leaseRes.lease,
      expectedRevision: 1,
      terminalStatus: 'confirmed',
      completedAt: new Date().toISOString(),
    });
    expect(done.committedRevision).toBe(1);
    expect(store.__turns.length).toBe(2);
    expect(store.__pending.get(p.id)?.status).toBe('confirmed');
  });
});
