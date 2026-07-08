import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import {
  CapabilityRegistry,
  buildCapabilityRuntimeDeps,
  createExecutionContext,
} from '@plumbus/core';
import { confirmPending, rejectPending, storePending } from '../pending-actions.js';
import { createSession } from '../../session/service.js';

describe('pending-actions ownership guards', () => {
  it('confirmPending returns notFound for foreign-user rows before mutating expiry', async () => {
    const ownerCtx = createTestContext({
      auth: { userId: 'owner', roles: [], scopes: [], provider: 'test' },
    });
    const session = await createSession(ownerCtx, {
      chatName: 'help',
      userId: 'owner',
      audience: 'user',
      locale: 'en',
    });
    const actionId = '00000000-0000-4000-8000-000000000040';
    await storePending(ownerCtx, {
      id: actionId,
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: {},
      schemaHash: 'legacy',
      confirmationMessage: 'Ship?',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      status: 'pending',
    });

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
      confirmPending(attacker, actionId, async () => ({}), 'legacy'),
    ).rejects.toMatchObject({ code: 'notFound' });

    const row = await ownerCtx.data.ChatPendingAction?.findById(actionId);
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
    const actionId = '00000000-0000-4000-8000-000000000041';
    await storePending(ctx, {
      id: actionId,
      sessionId: session.id,
      capabilityName: 'orders.ship',
      input: {},
      schemaHash: 'legacy',
      confirmationMessage: 'Ship?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    await expect(rejectPending(ctx, actionId, 'legacy')).resolves.toEqual({
      rejected: true,
      capabilityName: 'orders.ship',
    });
  });
});
