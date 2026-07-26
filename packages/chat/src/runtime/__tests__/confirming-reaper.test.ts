import { describe, expect, it } from 'vitest';
import {
  confirmingReapPredicate,
  fenceExpiredSessionLease,
  isResumeLeaseActive,
  type SessionLeaseCasRepo,
  sessionLeaseForConfirmingRow,
  shouldReapConfirming,
  staleConfirmingReason,
} from '../confirming-reaper.js';
import type { ChatPendingActionV2 } from '../../session/pending-action-v2.js';

function confirmingRow(overrides: Partial<ChatPendingActionV2> = {}): ChatPendingActionV2 {
  return {
    version: 2,
    id: 'action-1',
    sessionId: 'session-1',
    expectedSessionRevision: 0,
    capabilityName: 'testAction',
    input: {},
    inputSchemaHash: 'h',
    toolBindingHash: 'h',
    confirmationMessage: 'Confirm?',
    status: 'confirming',
    attemptId: 'attempt-1',
    claimedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    resumePayload: {
      version: 1,
      chatName: 'help',
      logicalTurnId: 'lt',
      proposalAssistantTurnId: 'lt',
      toolCallId: 'tc',
      toolName: 'testAction',
      messages: [],
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
    },
    ...overrides,
  };
}

describe('confirmingReapPredicate', () => {
  it('scopes the CAS to attemptId when present', () => {
    expect(confirmingReapPredicate(confirmingRow())).toEqual({
      status: 'confirming',
      attemptId: 'attempt-1',
    });
  });
});

describe('sessionLeaseForConfirmingRow', () => {
  it('re-reads lease when execution started but the first snapshot is inactive', async () => {
    const nowMs = Date.now();
    let reads = 0;
    const row = confirmingRow({ executionStartedAt: new Date(nowMs).toISOString() });
    const lease = await sessionLeaseForConfirmingRow(
      row,
      () => {
        reads += 1;
        if (reads === 1) return { leaseToken: null, leaseExpiresAt: null };
        return { leaseToken: 'attempt-1', leaseExpiresAt: new Date(nowMs + 60_000) };
      },
      nowMs,
    );

    expect(reads).toBe(2);
    expect(isResumeLeaseActive(lease, row.attemptId, nowMs)).toBe(true);
    expect(staleConfirmingReason(row, nowMs, lease)).toBe(false);
  });
});

describe('shouldReapConfirming (atomic reap fence)', () => {
  const nowMs = Date.now();

  it('does not reap and never calls the gate when the lease is live', async () => {
    const row = confirmingRow({ executionStartedAt: new Date(nowMs).toISOString() });
    const activeLease = { leaseToken: 'attempt-1', leaseExpiresAt: new Date(nowMs + 60_000) };
    let gateCalls = 0;
    const reap = await shouldReapConfirming(row, nowMs, activeLease, async () => {
      gateCalls += 1;
      return true;
    });
    expect(reap).toBe(false);
    expect(gateCalls).toBe(0);
  });

  it('does NOT reap a stale-read row when the gate detects a renewal in the gap', async () => {
    // Race: initial lease read was inactive (execution started, no active lease seen),
    // but a concurrent renewal re-activated the lease before the reap — the gate's fresh
    // read returns false, so a live confirm is never reaped.
    const row = confirmingRow({ executionStartedAt: new Date(nowMs).toISOString() });
    const inactiveLease = { leaseToken: null, leaseExpiresAt: null };
    let gateCalls = 0;
    const reap = await shouldReapConfirming(row, nowMs, inactiveLease, async () => {
      gateCalls += 1;
      return false; // fresh read observed the renewed (active) lease
    });
    expect(reap).toBe(false);
    expect(gateCalls).toBe(1);
  });

  it('reaps a genuinely orphaned row when the gate confirms the lease is dead', async () => {
    const row = confirmingRow({ executionStartedAt: new Date(nowMs).toISOString() });
    const inactiveLease = { leaseToken: null, leaseExpiresAt: null };
    const reap = await shouldReapConfirming(row, nowMs, inactiveLease, async () => true);
    expect(reap).toBe(true);
  });

  it('does not reap and never calls the gate during the post-claim grace window', async () => {
    // executionStartedAt unset + recent claimedAt → claim grace, still in-flight.
    const row = confirmingRow({
      claimedAt: new Date(nowMs).toISOString(),
      executionStartedAt: undefined,
    });
    const inactiveLease = { leaseToken: null, leaseExpiresAt: null };
    let gateCalls = 0;
    const reap = await shouldReapConfirming(row, nowMs, inactiveLease, async () => {
      gateCalls += 1;
      return true;
    });
    expect(reap).toBe(false);
    expect(gateCalls).toBe(0);
  });
});

describe('fenceExpiredSessionLease (single-CAS micro-gap close)', () => {
  const nowMs = Date.now();
  const observed = { leaseToken: 'attempt-1', leaseExpiresAt: new Date(nowMs - 1_000) };

  it('CAS keyed on token AND leaseExpiresAt; clears and reaps when unchanged', async () => {
    let seen: { leaseToken?: string | null; leaseExpiresAt?: Date | string | null } | null = null;
    const sessions: SessionLeaseCasRepo = {
      async updateWhere(_id, predicate, updates) {
        seen = predicate;
        expect(updates).toEqual({ leaseToken: null, leaseExpiresAt: null });
        return { matched: true };
      },
    };
    expect(await fenceExpiredSessionLease(sessions, 'session-1', observed)).toBe(true);
    // The predicate must pin BOTH the observed token and the observed expiry, so a
    // renewal (which bumps leaseExpiresAt) makes the CAS miss.
    expect(seen).toEqual({ leaseToken: 'attempt-1', leaseExpiresAt: observed.leaseExpiresAt });
  });

  it('does NOT reap when the CAS misses (renewal changed leaseExpiresAt in the gap)', async () => {
    const sessions: SessionLeaseCasRepo = {
      async updateWhere() {
        return { matched: false }; // observed expiry no longer matches → renewed
      },
    };
    expect(await fenceExpiredSessionLease(sessions, 'session-1', observed)).toBe(false);
  });

  it('reaps without a CAS when there is no lease token to fence', async () => {
    let called = false;
    const sessions: SessionLeaseCasRepo = {
      async updateWhere() {
        called = true;
        return { matched: true };
      },
    };
    expect(
      await fenceExpiredSessionLease(sessions, 'session-1', {
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    ).toBe(true);
    expect(called).toBe(false);
  });
});
