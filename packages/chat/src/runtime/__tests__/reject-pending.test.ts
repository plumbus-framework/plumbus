import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { rejectPending, storePending } from '../pending-actions.js';
import { createSession } from '../../session/service.js';

describe('rejectPending idempotency', () => {
  it('returns without error when row is already rejected', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'test-user',
      audience: 'user',
      locale: 'en',
    });

    await storePending(ctx, {
      id: '00000000-0000-4000-8000-000000000020',
      sessionId: session.id,
      capabilityName: 'testAction',
      input: {},
      schemaHash: 'legacy',
      confirmationMessage: 'confirm?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'rejected',
    });

    await expect(
      rejectPending(ctx, '00000000-0000-4000-8000-000000000020', 'legacy'),
    ).resolves.toEqual({ rejected: false });
  });

  it('returns without error when row is missing', async () => {
    const ctx = createTestContext();
    await expect(
      rejectPending(ctx, '00000000-0000-4000-8000-000000000099', 'legacy'),
    ).resolves.toEqual({ rejected: false });
  });
});
