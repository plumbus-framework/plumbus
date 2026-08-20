import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import { CapabilityRegistry, buildCapabilityRuntimeDeps, defineCapability } from '@plumbus/core';
import { createExecutionContext } from '@plumbus/core/runtime';
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { defineChat } from '../../define/defineChat.js';
import type {
  ChatPendingActionV2,
  ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';
import type { ChatConversationStore } from '../chat-conversation-store.js';
import type { ChatEvent } from '../../types/event.js';
import { chatPendingActionRepo } from '../../internal/chat-repos.js';
import { resumeAfterConfirm } from '../resume-after-confirm.js';

import * as runTurn from '../run-turn.js';

vi.mock('../run-turn.js', async (importOriginal) => {
  const actual = await importOriginal<typeof runTurn>();
  return { ...actual, resumeToolLoop: vi.fn() };
});

const resumeToolLoopMock = vi.mocked(runTurn.resumeToolLoop);

function minimalResume(overrides: Partial<ChatToolResumePayloadV1> = {}): ChatToolResumePayloadV1 {
  return {
    version: 1,
    chatName: 'help',
    logicalTurnId: 'lt-1',
    proposalAssistantTurnId: 'prop-1',
    toolCallId: 'tc-1',
    toolName: 'orders.ship',
    messages: [{ role: 'user', content: 'ship it' }],
    counters: {
      toolRoundsUsed: 2,
      flowStartsUsed: 1,
      flowAwaitMsUsed: 100,
      inputTokensUsed: 50,
      outputTokensUsed: 25,
      costUsed: 0.01,
    },
    toolsExecuted: [],
    sourceRefs: [],
    ...overrides,
  };
}

function pendingRow(overrides: Partial<ChatPendingActionV2> = {}): ChatPendingActionV2 {
  return {
    version: 2,
    id: '00000000-0000-4000-8000-000000000101',
    sessionId: '00000000-0000-4000-8000-000000000100',
    expectedSessionRevision: 0,
    capabilityName: 'orders.ship',
    input: { orderId: 'o-1' },
    inputSchemaHash: 'hash-a',
    toolBindingHash: 'bind-a',
    confirmationMessage: 'Ship?',
    status: 'confirming',
    attemptId: 'attempt-1',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

function fakeStore(overrides: Partial<ChatConversationStore> = {}): ChatConversationStore {
  return {
    acquireSessionMutation: vi.fn(async () => ({
      acquired: true as const,
      lease: {
        sessionId: '00000000-0000-4000-8000-000000000100',
        leaseToken: 'lease-1',
        acquiredAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        sessionRevision: 0,
      },
    })),
    renewSessionMutation: vi.fn(async () => ({ renewed: true })),
    releaseSessionMutation: vi.fn(async () => {}),
    commitTurn: vi.fn(),
    commitProposal: vi.fn(),
    claimPending: vi.fn(),
    markExecutionStarted: vi.fn(async () => {}),
    completePending: vi.fn(async () => ({ committedRevision: 1 })),
    inspectSession: vi.fn(),
    peekPending: vi.fn(),
    rejectPending: vi.fn(),
    commitResumeProposal: vi.fn(async () => ({
      committedRevision: 1,
      ordinals: [2],
      actionId: 'new-action',
    })),
    ...overrides,
  };
}

function ctxWithCap() {
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
  const base = createTestContext({ ai: mockAI({ generate: { ok: true } }) });
  return createExecutionContext({
    auth: base.auth,
    data: base.data,
    events: base.events,
    audit: base.audit,
    logger: base.logger,
    time: base.time,
    ai: base.ai,
    ...buildCapabilityRuntimeDeps(registry),
  });
}

describe('resumeAfterConfirm', () => {
  beforeEach(() => {
    resumeToolLoopMock.mockReset();
  });

  it('restores cumulative counters without resetting them', async () => {
    const payload = minimalResume();
    resumeToolLoopMock.mockResolvedValue({
      kind: 'answer',
      answer: 'done',
      inScope: true,
      refusalReason: null,
      model: 'test',
      usage: { tokensIn: 1, tokensOut: 2 },
      cost: 0,
      sourceRefs: [],
      toolsExecuted: [],
    });
    const store = fakeStore();
    const events: ChatEvent[] = [];
    let result: unknown;
    await resumeAfterConfirm(ctxWithCap(), {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: pendingRow({ resumePayload: payload }),
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: (r) => {
        result = r;
      },
    });
    expect(resumeToolLoopMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        counters: payload.counters,
      }),
    );
    expect((result as { resume: { status: string } }).resume.status).toBe('completed');
  });

  it('executes the confirmed capability then emits tool.completed + turn.completed', async () => {
    resumeToolLoopMock.mockResolvedValue({
      kind: 'answer',
      answer: 'Shipped',
      inScope: true,
      refusalReason: null,
      model: 'test',
      usage: { tokensIn: 1, tokensOut: 2 },
      cost: 0.001,
      sourceRefs: [],
      toolsExecuted: [],
    });
    const store = fakeStore();
    const events: Array<{ type: string }> = [];
    let result: unknown;
    await resumeAfterConfirm(ctxWithCap(), {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: pendingRow(),
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: (r) => {
        result = r;
      },
    });
    expect(events.some((e) => e.type === 'tool.completed')).toBe(true);
    expect(events.some((e) => e.type === 'turn.completed')).toBe(true);
    expect(events.some((e) => e.type === 'confirmation.resolved')).toBe(true);
    expect(store.completePending).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: 'confirmed', resumeTurn: expect.any(Object) }),
    );
    expect(result).toMatchObject({
      pendingStatus: 'confirmed',
      execution: { status: 'succeeded' },
      resume: { status: 'completed' },
    });
  });

  it('on capability failure emits tool.failed and turn.failed chat.tool_failed', async () => {
    const cap = defineCapability({
      name: 'ship',
      kind: 'action',
      domain: 'orders',
      access: {},
      input: z.object({ orderId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => {
        throw new Error('boom');
      },
    });
    const registry = new CapabilityRegistry();
    registry.register(cap);
    const base = createTestContext();
    const ctx = createExecutionContext({
      auth: base.auth,
      data: base.data,
      events: base.events,
      audit: base.audit,
      logger: base.logger,
      time: base.time,
      ai: base.ai,
      ...buildCapabilityRuntimeDeps(registry),
    });
    const store = fakeStore();
    const events: Array<{ type: string; code?: string }> = [];
    await resumeAfterConfirm(ctx, {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: pendingRow(),
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: () => {},
    });
    expect(events.some((e) => e.type === 'tool.failed')).toBe(true);
    expect(events.some((e) => e.type === 'turn.failed' && e.code === 'chat.tool_failed')).toBe(
      true,
    );
    expect(store.completePending).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: 'failed' }),
    );
    expect(store.completePending).not.toHaveBeenCalledWith(
      expect.objectContaining({ resumeTurn: expect.anything() }),
    );
  });

  it('resume-fail-after-invoke keeps execution succeeded and emits turn.failed chat.resume_failed without rollback', async () => {
    resumeToolLoopMock.mockRejectedValue(new Error('resume blew up'));
    const store = fakeStore();
    const events: Array<{ type: string; code?: string }> = [];
    let result: unknown;
    await resumeAfterConfirm(ctxWithCap(), {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: pendingRow(),
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: (r) => {
        result = r;
      },
    });
    expect(result).toMatchObject({
      execution: { status: 'succeeded' },
      resume: { status: 'failed' },
    });
    expect(store.completePending).toHaveBeenCalledWith(
      expect.objectContaining({ terminalStatus: 'confirmed' }),
    );
    expect(events.some((e) => e.type === 'turn.failed' && e.code === 'chat.resume_failed')).toBe(
      true,
    );
    expect(resumeToolLoopMock).toHaveBeenCalledTimes(1);
  });

  it('nested confirm finalizes original and emits a new confirmation_required', async () => {
    resumeToolLoopMock.mockResolvedValue({
      kind: 'paused',
      newPending: pendingRow({ id: '00000000-0000-4000-8000-000000000202', status: 'pending' }),
      assistantTurn: {
        role: 'assistant',
        content: 'Need another confirm',
        inScope: true,
        sources: [],
        logicalTurnId: 'lt-1',
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: '',
        latencyMs: 0,
      },
      confirmation: {
        actionId: '00000000-0000-4000-8000-000000000202',
        capabilityName: 'orders.ship',
        confirmationMessage: 'Again?',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        inputSchemaHash: 'hash-b',
      },
      sourceRefs: [],
      toolsExecuted: [],
    });
    const store = fakeStore();
    const events: Array<{ type: string; actionId?: string; inputSchemaHash?: string }> = [];
    await resumeAfterConfirm(ctxWithCap(), {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: pendingRow(),
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: () => {},
    });
    expect(store.commitResumeProposal).toHaveBeenCalled();
    const nested = events.find((e) => e.type === 'confirmation_required');
    expect(nested?.actionId).toBe('00000000-0000-4000-8000-000000000202');
    expect(nested?.inputSchemaHash).toBe('hash-b');
  });

  it('terminalizes confirming when markExecutionStarted throws', async () => {
    const ctx = ctxWithCap();
    const row = pendingRow();
    await chatPendingActionRepo(ctx).create(row);
    const store = fakeStore({
      markExecutionStarted: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    });
    const events: ChatEvent[] = [];
    await resumeAfterConfirm(ctx, {
      chat: defineChat({ name: 'help', access: {}, instructions: ['x'] }),
      store,
      pending: row,
      owner: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
      emit: (evt) => {
        events.push(evt);
      },
      onResult: () => {},
    });
    const updated = await chatPendingActionRepo(ctx).findById(row.id);
    expect(updated?.status).toBe('failed');
    expect(events.some((e) => e.type === 'turn.failed')).toBe(true);
  });
});
