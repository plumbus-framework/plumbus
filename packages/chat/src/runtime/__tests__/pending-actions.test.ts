import { describe, expect, it } from 'vitest';
import { createTestContext } from '@plumbus/core/testing';
import { checkLivePending } from '../pending-actions.js';
import { CONFIRMING_LEASE_GRACE_MS, fenceExpiredSessionLease } from '../confirming-reaper.js';
import { chatPendingActionRepo, chatSessionRepo } from '../../internal/chat-repos.js';
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
    id: '00000000-0000-4000-8000-000000000001',
    sessionId,
    expectedSessionRevision: 0,
    capabilityName: 'testAction',
    input: { x: 1 },
    inputSchemaHash: 'hash-1',
    toolBindingHash: 'hash-1',
    confirmationMessage: 'Confirm?',
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: minimalResume(),
    ...overrides,
  };
}

describe('checkLivePending', () => {
  it('returns chat.pending_action_exists for a live pending row', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(pending(session.id));

    const live = await checkLivePending(ctx, session.id);
    expect(live).toMatchObject({
      blocked: true,
      code: 'chat.pending_action_exists',
      actionId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('returns chat.session_busy when an action is confirming with an active resume lease', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const attemptId = 'a1';
    await chatSessionRepo(ctx).update(session.id, {
      leaseToken: attemptId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        status: 'confirming',
        attemptId,
        claimedAt: new Date().toISOString(),
        executionStartedAt: new Date().toISOString(),
      }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toMatchObject({ blocked: true, code: 'chat.session_busy' });
  });

  it('returns chat.session_busy during claim grace before resume acquires the lease', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        status: 'confirming',
        attemptId: 'a1',
        claimedAt: new Date().toISOString(),
      }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toMatchObject({ blocked: true, code: 'chat.session_busy' });
  });

  it('does not reap a confirming row whose propose-time expiresAt elapsed while resume lease is active', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const attemptId = 'a1';
    await chatSessionRepo(ctx).update(session.id, {
      leaseToken: attemptId,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        status: 'confirming',
        attemptId,
        claimedAt: new Date().toISOString(),
        executionStartedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toMatchObject({ blocked: true, code: 'chat.session_busy' });
  });

  it('terminalizes an orphaned confirming row when resume lease expired and allows the turn', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        status: 'confirming',
        attemptId: 'a1',
        claimedAt: new Date(Date.now() - CONFIRMING_LEASE_GRACE_MS - 1000).toISOString(),
        executionStartedAt: new Date(Date.now() - CONFIRMING_LEASE_GRACE_MS - 1000).toISOString(),
      }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toEqual({ blocked: false });
    const row = await chatPendingActionRepo(ctx).findById('00000000-0000-4000-8000-000000000001');
    expect(row?.status).toBe('failed');
  });

  it('terminalizes an expired pending and allows the turn', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toEqual({ blocked: false });
    const row = await chatPendingActionRepo(ctx).findById('00000000-0000-4000-8000-000000000001');
    expect(row?.status).toBe('expired');
  });

  // Integration: exercises the fence CAS through the REAL repo comparator (not a stub),
  // so the Date-valued { leaseToken, leaseExpiresAt } predicate is verified end-to-end.
  it('reaps a confirming row whose lease token is present but expired (CAS-match path), clearing the lease', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    const old = new Date(Date.now() - CONFIRMING_LEASE_GRACE_MS - 1000);
    await chatSessionRepo(ctx).update(session.id, {
      leaseToken: 'a1',
      leaseExpiresAt: new Date(Date.now() - 1000), // expired, token present
    });
    await chatPendingActionRepo(ctx).create(
      pending(session.id, {
        status: 'confirming',
        attemptId: 'a1',
        claimedAt: old.toISOString(),
        executionStartedAt: old.toISOString(),
      }),
    );

    const live = await checkLivePending(ctx, session.id);
    expect(live).toEqual({ blocked: false });
    const row = await chatPendingActionRepo(ctx).findById('00000000-0000-4000-8000-000000000001');
    expect(row?.status).toBe('failed');
    const s = await chatSessionRepo(ctx).findById(session.id);
    expect(s?.leaseToken ?? null).toBe(null); // fence cleared the dead lease
  });

  // Renewal-in-gap guard against the REAL repo: the fence CAS must MISS when the stored
  // leaseExpiresAt differs from the observed (pre-renewal) value, so a live confirm survives.
  it('fenceExpiredSessionLease declines (no reap) when a renewal changed the stored lease expiry', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    // Stored state = "renewed" (future expiry); observed = the older pre-renewal expiry.
    await chatSessionRepo(ctx).update(session.id, {
      leaseToken: 'a1',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const declined = await fenceExpiredSessionLease(chatSessionRepo(ctx), session.id, {
      leaseToken: 'a1',
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    expect(declined).toBe(false);
    const s = await chatSessionRepo(ctx).findById(session.id);
    expect(s?.leaseToken).toBe('a1'); // lease left intact
  });

  it('fails closed with chat.storage_unsupported when a reap is needed but updateWhere is missing', async () => {
    const ctx = createTestContext();
    const session = await createSession(ctx, {
      chatName: 'help',
      userId: ctx.auth.userId ?? 'u1',
      audience: 'user',
      locale: 'en',
    });
    // A confirming row means checkLivePending will need a conditional write.
    await chatPendingActionRepo(ctx).create(
      pending(session.id, { status: 'confirming', attemptId: 'a1' }),
    );
    // Simulate a store (older @plumbus/core) without a conditional-write path.
    (ctx.data as Record<string, { updateWhere?: unknown }>).ChatPendingAction.updateWhere =
      undefined;

    await expect(checkLivePending(ctx, session.id)).rejects.toThrow(/conditional-write/i);
  });
});
