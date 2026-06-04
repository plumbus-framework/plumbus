import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { confirmPending, storePending } from '../pending-actions.js';
import { createSession } from '../../session/service.js';

describe('confirmPending', () => {
  it('rejects confirmation by a non-owner', async () => {
    const ctxA = createTestContext({
      auth: { userId: 'user-a', roles: ['user'], scopes: [], provider: 'test' },
    });
    const session = await createSession(ctxA, {
      chatName: 'help',
      userId: 'user-a',
      audience: 'user',
      locale: 'en',
    });

    const actionId = '00000000-0000-4000-8000-000000000001';
    await storePending(ctxA, {
      id: actionId,
      sessionId: session.id,
      capabilityName: 'testAction',
      input: { x: 1 },
      schemaHash: 'hash-1',
      confirmationMessage: 'Confirm?',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: 'pending',
    });

    const ctxB = createTestContext({
      auth: { userId: 'user-b', roles: ['user'], scopes: [], provider: 'test' },
    });

    await expect(
      confirmPending(ctxB, actionId, async () => ({ ok: true }), 'hash-1'),
    ).rejects.toMatchObject({ code: 'notFound' });
  });
});
