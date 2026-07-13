import { describe, expect, it, vi } from 'vitest';
import { z } from '@plumbus/core/zod';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  createExecutionContext,
  defineCapability,
} from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { actionGuard } from '../action-guard.js';
import { createSession } from '../../session/service.js';
import { storePending } from '../../runtime/pending-actions.js';

function ctxWithRegistry(registry: CapabilityRegistry) {
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

describe('C6 action-guard matrix extensions', () => {
  it('blocks invalid propose input with action_input_invalid', async () => {
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

    const verdict = await actionGuard(
      { sessionId: 's1', ordinal: 0, userId: 'u1', audience: 'user', locale: 'en' },
      {
        ctx,
        chatName: 'help',
        policy: {},
        resolvedSources: new Set(),
        saveToDb: true,
        modelOutput: {
          requestedAction: {
            capabilityName: 'orders.ship',
            input: { orderId: 123 },
            confirmationMessage: 'Ship?',
          },
        },
      },
    );

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('action_input_invalid');
  });

  it('blocks when pending action cap is reached (action_budget_exceeded)', async () => {
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
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000030',
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: { orderId: 'o-1' },
      schemaHash: 'legacy',
      confirmationMessage: 'pending',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    const verdict = await actionGuard(
      { sessionId: session.id, ordinal: 0, userId: 'u1', audience: 'user', locale: 'en' },
      {
        ctx,
        chatName: 'help',
        policy: {},
        resolvedSources: new Set(),
        saveToDb: true,
        budgetActionsPerSession: 1,
        modelOutput: {
          requestedAction: {
            capabilityName: 'orders.ship',
            input: { orderId: 'o-2' },
            confirmationMessage: 'Ship?',
          },
        },
      },
    );

    expect(verdict.decision).toBe('block');
    expect(verdict.reason).toBe('action_budget_exceeded');
  });

  it('warns and uses legacy hash when describe is unavailable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = ctxWithRegistry(new CapabilityRegistry());

    const verdict = await actionGuard(
      { sessionId: 's1', ordinal: 0, userId: 'u1', audience: 'user', locale: 'en' },
      {
        ctx,
        chatName: 'help',
        policy: {},
        resolvedSources: new Set(),
        saveToDb: true,
        modelOutput: {
          requestedAction: {
            capabilityName: 'missing.cap',
            input: { x: 1 },
            confirmationMessage: 'Go?',
          },
        },
      },
    );

    expect(verdict.decision).toBe('require_confirmation');
    expect(verdict.pendingAction?.schemaHash).not.toMatch(/^v2:/);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ctx.capabilities.describe unavailable'),
    );
    warnSpy.mockRestore();
  });
});
