import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { createTestContext } from '@plumbus/core/testing';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  createExecutionContext,
  defineCapability,
} from '@plumbus/core';
import type { ExecutionContext } from '@plumbus/core';
import { capabilityActionHashV2 } from '../../policy/action-schema-hash.js';
import { actionGuard } from '../../policy/action-guard.js';
import { confirmPending, storePending } from '../pending-actions.js';
import { createSession } from '../../session/service.js';

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

function ctxWithSharedData(
  registry: CapabilityRegistry,
  shared: ExecutionContext,
): ExecutionContext {
  return createExecutionContext({
    auth: shared.auth,
    data: shared.data,
    events: shared.events,
    audit: shared.audit,
    logger: shared.logger,
    time: shared.time,
    ...buildCapabilityRuntimeDeps(registry),
  });
}

describe('C6 action-confirm matrix', () => {
  it('uses real core describe + v2 hash binding schema and payload', async () => {
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

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000002',
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: { orderId: 'o-1' },
      schemaHash: hash,
      confirmationMessage: 'Ship order?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    await expect(
      confirmPending(ctx, '00000000-0000-4000-8000-000000000002', async () => ({ ok: true }), hash),
    ).resolves.toEqual({ ok: true });
  });

  it('rejects v2 confirm when capability schema changes after propose', async () => {
    const v1 = defineCapability({
      name: 'ship',
      kind: 'action',
      domain: 'orders',
      input: z.object({ orderId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });
    const registryV1 = new CapabilityRegistry();
    registryV1.register(v1);
    const ctxV1 = ctxWithRegistry(registryV1);

    const described = ctxV1.capabilities.describe?.('orders.ship');
    const hash = capabilityActionHashV2(described?.inputSchema ?? {}, { orderId: 'o-1' });

    const session = await createSession(ctxV1, {
      chatName: 'help',
      userId: ctxV1.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await storePending(ctxV1, {
      id: '00000000-0000-4000-8000-000000000003',
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: { orderId: 'o-1' },
      schemaHash: hash,
      confirmationMessage: 'Ship?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    const registryV2 = new CapabilityRegistry();
    registryV2.register(
      defineCapability({
        name: 'ship',
        kind: 'action',
        domain: 'orders',
        input: z.object({ orderId: z.string(), tracking: z.string() }),
        output: z.object({ ok: z.boolean() }),
        effects: { data: [], events: [], external: [], ai: false },
        handler: async () => ({ ok: true }),
      }),
    );
    const ctxV2 = ctxWithSharedData(registryV2, ctxV1);

    await expect(
      confirmPending(
        ctxV2,
        '00000000-0000-4000-8000-000000000003',
        async () => ({ ok: true }),
        hash,
      ),
    ).rejects.toMatchObject({ metadata: { code: 'chat.action_schema_changed' } });
  });

  it('action-guard blocks when pending cap excludes expired rows', async () => {
    const ctx = ctxWithRegistry(new CapabilityRegistry());
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000010',
      sessionId: session.id,
      capabilityName: 'testAction',
      input: {},
      schemaHash: 'legacy',
      confirmationMessage: 'old',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'pending',
    });

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

  it('accepts legacy unprefixed schema hash via echo compare', async () => {
    const ctx = ctxWithRegistry(new CapabilityRegistry());
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });
    const legacyHash = 'abc123legacy';

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000020',
      sessionId: session.id,
      capabilityName: 'unknown.cap',
      input: { x: 1 },
      schemaHash: legacyHash,
      confirmationMessage: 'Confirm?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    await expect(
      confirmPending(
        ctx,
        '00000000-0000-4000-8000-000000000020',
        async () => ({ ok: true }),
        legacyHash,
      ),
    ).resolves.toEqual({ ok: true });
  });

  it('distinguishes action_schema_mismatch (echo) from action_schema_changed (re-derived)', async () => {
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
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    const described = ctx.capabilities.describe?.('orders.ship');
    const hash = capabilityActionHashV2(described?.inputSchema ?? {}, { orderId: 'o-1' });

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000021',
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: { orderId: 'o-1' },
      schemaHash: hash,
      confirmationMessage: 'Ship?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    await expect(
      confirmPending(
        ctx,
        '00000000-0000-4000-8000-000000000021',
        async () => ({ ok: true }),
        'wrong-echo',
      ),
    ).rejects.toMatchObject({ metadata: { code: 'chat.action_schema_mismatch' } });

    await expect(
      confirmPending(ctx, '00000000-0000-4000-8000-000000000021', async () => ({ ok: true }), hash),
    ).resolves.toEqual({ ok: true });
  });
});
