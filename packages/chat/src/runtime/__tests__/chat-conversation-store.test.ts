import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';
import { createSession } from '../../session/service.js';
import {
  assertChatStorageSupported,
  createChatConversationStore,
  type ChatTurnWrite,
} from '../chat-conversation-store.js';

function minimalResume(overrides: Partial<ChatToolResumePayloadV1> = {}): ChatToolResumePayloadV1 {
  return {
    version: 1,
    chatName: 'help',
    logicalTurnId: 'lt-1',
    proposalAssistantTurnId: 'lt-1',
    toolCallId: 'tc-1',
    toolName: 'orders.ship',
    messages: [{ role: 'user', content: 'ship it' }],
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
    ...overrides,
  };
}

function userTurn(logicalTurnId = 'lt-1'): ChatTurnWrite {
  return {
    role: 'user',
    content: 'ship it',
    inScope: true,
    sources: [],
    logicalTurnId,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    model: '',
    latencyMs: 0,
  };
}

function assistantTurn(logicalTurnId = 'lt-1'): ChatTurnWrite {
  return {
    role: 'assistant',
    content: 'Confirm ship?',
    inScope: true,
    sources: [],
    logicalTurnId,
    tokensIn: 1,
    tokensOut: 2,
    costUsd: 0.001,
    model: 'test',
    latencyMs: 0,
  };
}

function pendingRow(
  sessionId: string,
  overrides: Partial<ChatPendingActionV2> = {},
): ChatPendingActionV2 {
  return {
    version: 2,
    id: '00000000-0000-4000-8000-000000000101',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: { orderId: 'o-1' },
    inputSchemaHash: 'hash-a',
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

describe('createChatConversationStore', () => {
  it('acquireSessionMutation returns session_busy for a live lease and single-winner otherwise', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);

    const first = await store.acquireSessionMutation({
      sessionId: session.id,
      ownerToken: 'lease-1',
      leaseMs: 30_000,
    });
    expect(first.acquired).toBe(true);

    const busy = await store.acquireSessionMutation({
      sessionId: session.id,
      ownerToken: 'lease-2',
      leaseMs: 30_000,
    });
    expect(busy).toEqual({
      acquired: false,
      reason: 'session_busy',
      heldUntil: expect.any(String),
    });

    await store.releaseSessionMutation({ sessionId: session.id, leaseToken: 'lease-1' });
    const second = await store.acquireSessionMutation({
      sessionId: session.id,
      ownerToken: 'lease-3',
      leaseMs: 30_000,
    });
    expect(second.acquired).toBe(true);
  });

  it('commitProposal writes user+assistant turns + pending and bumps revision once', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);
    const leaseRes = await store.acquireSessionMutation({
      sessionId: session.id,
      ownerToken: 'lease-a',
      leaseMs: 30_000,
    });
    if (!leaseRes.acquired) throw new Error('expected lease');

    const pending = pendingRow(session.id);
    const result = await store.commitProposal({
      lease: leaseRes.lease,
      expectedRevision: 0,
      userTurn: userTurn(),
      assistantTurn: assistantTurn(),
      pending,
    });

    expect(result.committedRevision).toBe(1);
    expect(result.ordinals).toEqual([0, 1]);
    const stored = await ctx.data.ChatPendingAction?.findById(pending.id);
    expect(stored?.status).toBe('pending');
    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    expect(turns?.length).toBe(2);
  });

  it('claimPending flips exactly one concurrent claimer to confirming; the other gets already_claimed', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);
    const pending = pendingRow(session.id);
    await ctx.data.ChatPendingAction?.create(pending);

    const claim1 = store.claimPending({
      actionId: pending.id,
      owner: ctx.auth,
      chatName: 'help',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-1',
      now: new Date().toISOString(),
    });
    const claim2 = store.claimPending({
      actionId: pending.id,
      owner: ctx.auth,
      chatName: 'help',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-2',
      now: new Date().toISOString(),
    });
    const [a, b] = await Promise.all([claim1, claim2]);
    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(['already_claimed', 'claimed']);
  });

  it('claimPending returns stale when session revision advanced since proposal', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await ctx.data.ChatSession?.update(session.id, { revision: 2 });
    const store = createChatConversationStore(ctx);
    const pending = pendingRow(session.id, { expectedSessionRevision: 0 });
    await ctx.data.ChatPendingAction?.create(pending);

    const claim = await store.claimPending({
      actionId: pending.id,
      owner: ctx.auth,
      chatName: 'help',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-1',
      now: new Date().toISOString(),
    });
    expect(claim.outcome).toBe('stale');
  });

  it('claimPending returns binding_changed on inputSchemaHash/toolBindingHash mismatch', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);
    const pending = pendingRow(session.id);
    await ctx.data.ChatPendingAction?.create(pending);

    const claim = await store.claimPending({
      actionId: pending.id,
      owner: ctx.auth,
      chatName: 'help',
      inputSchemaHash: 'wrong',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-1',
      now: new Date().toISOString(),
    });
    expect(claim.outcome).toBe('binding_changed');
  });

  it('claimPending returns expired and terminalizes an expired pending', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);
    const pending = pendingRow(session.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    await ctx.data.ChatPendingAction?.create(pending);

    const claim = await store.claimPending({
      actionId: pending.id,
      owner: ctx.auth,
      chatName: 'help',
      inputSchemaHash: 'hash-a',
      toolBindingHash: 'bind-a',
      attemptId: 'attempt-1',
      now: new Date().toISOString(),
    });
    expect(claim.outcome).toBe('expired');
    const row = await ctx.data.ChatPendingAction?.findById(pending.id);
    expect(row?.status).toBe('expired');
  });

  it('completePending(confirmed, resumeTurn) appends the resume turn and bumps revision', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const store = createChatConversationStore(ctx);
    const leaseRes = await store.acquireSessionMutation({
      sessionId: session.id,
      ownerToken: 'lease-r',
      leaseMs: 30_000,
    });
    if (!leaseRes.acquired) throw new Error('expected lease');
    const pending = pendingRow(session.id, {
      status: 'confirming',
      attemptId: 'attempt-r',
    });
    await ctx.data.ChatPendingAction?.create(pending);

    const result = await store.completePending({
      actionId: pending.id,
      attemptId: 'attempt-r',
      lease: leaseRes.lease,
      expectedRevision: 0,
      terminalStatus: 'confirmed',
      completedAt: new Date().toISOString(),
      resumeTurn: assistantTurn('lt-resume'),
    });

    expect(result.committedRevision).toBe(1);
    const turns = await ctx.data.ChatTurn?.findMany({ sessionId: session.id });
    expect(turns?.length).toBe(1);
  });

  it('assertChatStorageSupported throws chat.storage_unsupported when repos lack updateWhere', () => {
    const bareRepo = {
      findById: async () => null,
      create: async (d: unknown) => d,
      update: async (_id: string, d: unknown) => d,
      findMany: async () => [],
    };
    const ctx = createTestContext();
    (ctx.data as Record<string, unknown>).ChatSession = bareRepo;
    expect(() => assertChatStorageSupported(ctx)).toThrowError(
      expect.objectContaining({
        metadata: expect.objectContaining({ code: 'chat.storage_unsupported' }),
      }),
    );
  });
});
