import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  createExecutionContext,
  defineCapability,
} from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { buildNormalizedPending } from '../pending-action-factory.js';
import {
  CHAT_RESUME_PAYLOAD_MAX_BYTES,
  type ChatToolResumePayloadV1,
} from '../../session/pending-action-v2.js';

function ctxWithCap(cap: ReturnType<typeof defineCapability>) {
  const base = createTestContext();
  const registry = new CapabilityRegistry();
  registry.register(cap);
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

describe('buildNormalizedPending', () => {
  const shipCap = defineCapability({
    name: 'ship',
    kind: 'action',
    domain: 'orders',
    input: z.object({ orderId: z.string(), priority: z.number().default(1) }),
    output: z.object({ ok: z.boolean() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });

  it('normalizes input via the capability Zod validator and stores only the normalized value', () => {
    const ctx = ctxWithCap(shipCap);
    const raw = { orderId: 'o-1' };
    const built = buildNormalizedPending({
      ctx,
      sessionId: 's1',
      expectedSessionRevision: 0,
      capabilityName: 'orders.ship',
      rawInput: raw,
      confirmationMessage: 'Ship?',
      ttlMs: 60_000,
      resumePayload: minimalResume(),
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.pending.input).toEqual({ orderId: 'o-1', priority: 1 });
    expect(built.pending.input).not.toEqual(raw);
  });

  it('returns chat.tool_arguments_invalid on parse failure with no pending built', () => {
    const ctx = ctxWithCap(shipCap);
    const built = buildNormalizedPending({
      ctx,
      sessionId: 's1',
      expectedSessionRevision: 0,
      capabilityName: 'orders.ship',
      rawInput: { orderId: 123 },
      confirmationMessage: 'Ship?',
      ttlMs: 60_000,
      resumePayload: minimalResume(),
    });
    expect(built).toEqual({ ok: false, code: 'chat.tool_arguments_invalid' });
  });

  it('returns chat.tool_unknown_capability when resolveCapability misses', () => {
    const ctx = createTestContext();
    const built = buildNormalizedPending({
      ctx,
      sessionId: 's1',
      expectedSessionRevision: 0,
      capabilityName: 'missing.cap',
      rawInput: {},
      confirmationMessage: 'Do?',
      ttlMs: 60_000,
      resumePayload: minimalResume(),
    });
    expect(built).toEqual({ ok: false, code: 'chat.tool_unknown_capability' });
  });

  it('returns chat.resume_payload_invalid when the serialized payload exceeds 256 KiB', () => {
    const ctx = ctxWithCap(shipCap);
    const huge = 'x'.repeat(CHAT_RESUME_PAYLOAD_MAX_BYTES);
    const built = buildNormalizedPending({
      ctx,
      sessionId: 's1',
      expectedSessionRevision: 0,
      capabilityName: 'orders.ship',
      rawInput: { orderId: 'o-1' },
      confirmationMessage: 'Ship?',
      ttlMs: 60_000,
      resumePayload: {
        ...minimalResume(),
        messages: [{ role: 'user', content: huge }],
      },
    });
    expect(built).toEqual({ ok: false, code: 'chat.resume_payload_invalid' });
  });
});
