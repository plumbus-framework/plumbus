import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';

/** Aligns with resume-after-confirm RESUME_LEASE_MS — grace while claim awaits lease acquire. */
export const CONFIRMING_LEASE_GRACE_MS = 30_000;

/** Session lease fields used to decide whether a confirming row is still in-flight. */
export type SessionLeaseSnapshot = {
  leaseToken?: string | null;
  leaseExpiresAt?: Date | string | number | null;
};

/** True when the session holds an active resume lease owned by `attemptId`. */
export function isResumeLeaseActive(
  session: SessionLeaseSnapshot,
  attemptId: string | undefined,
  nowMs: number,
): boolean {
  if (!attemptId || !session.leaseToken || !session.leaseExpiresAt) return false;
  if (session.leaseToken !== attemptId) return false;
  return new Date(session.leaseExpiresAt).getTime() > nowMs;
}

/** Grace window after claim while resume acquires the session lease (same request). */
export function isConfirmingClaimGrace(row: ChatPendingActionV2, nowMs: number): boolean {
  if (!row.claimedAt || row.executionStartedAt) return false;
  return nowMs - new Date(row.claimedAt).getTime() <= CONFIRMING_LEASE_GRACE_MS;
}

/**
 * Returns `'orphaned'` when a confirming row should be reaped, or false when still
 * in-flight. Claimed confirming rows are never reaped on propose-time `expiresAt`.
 * Liveness is the resume session lease (renewed during work), with a short grace
 * after claim before the lease is acquired.
 */
export function staleConfirmingReason(
  row: ChatPendingActionV2,
  nowMs: number,
  session: SessionLeaseSnapshot,
): 'orphaned' | false {
  if (row.status !== 'confirming') return false;
  if (isResumeLeaseActive(session, row.attemptId, nowMs)) return false;
  if (isConfirmingClaimGrace(row, nowMs)) return false;
  return 'orphaned';
}

export function terminalStatusForStaleConfirming(): ChatPendingActionV2['status'] {
  return 'failed';
}

/** CAS predicate for reaping a confirming row — scoped to the live attempt when known. */
export function confirmingReapPredicate(row: ChatPendingActionV2): Partial<ChatPendingActionV2> {
  return row.attemptId
    ? { status: 'confirming', attemptId: row.attemptId }
    : { status: 'confirming' };
}

export type SessionLeaseLoader = () => SessionLeaseSnapshot | Promise<SessionLeaseSnapshot>;

/**
 * Load session lease for a confirming row after the pending row is observed.
 * Re-reads once when execution has started but the first lease snapshot is inactive,
 * closing the READ COMMITTED skew where lease was read before acquire completed.
 */
export async function sessionLeaseForConfirmingRow(
  row: ChatPendingActionV2,
  loadSessionLease: SessionLeaseLoader,
  nowMs: number,
): Promise<SessionLeaseSnapshot> {
  let session = await loadSessionLease();
  if (
    row.executionStartedAt &&
    row.attemptId &&
    !isResumeLeaseActive(session, row.attemptId, nowMs)
  ) {
    session = await loadSessionLease();
  }
  return session;
}

/**
 * Gate that atomically confirms a confirming row is safe to reap.
 * Called only after `staleConfirmingReason` read the lease as inactive; it re-checks
 * the lease with a FRESH read and, when a dead lease token is present, clears it with a
 * token-scoped CAS. Returns `false` (do not reap) when the fresh read shows an active
 * lease — closing the read→reap window where a concurrent renewal re-activated the lease.
 */
export type ConfirmingReapGate = () => Promise<boolean>;

/**
 * Decide whether to reap a confirming row. Returns `true` only when the row is stale
 * AND the gate atomically confirms the session lease is genuinely inactive. A renewal
 * landing between the initial lease read and the gate makes the gate return `false`, so
 * a live (renewed) confirm is never reaped.
 */
export async function shouldReapConfirming(
  row: ChatPendingActionV2,
  nowMs: number,
  session: SessionLeaseSnapshot,
  gate: ConfirmingReapGate,
): Promise<boolean> {
  if (staleConfirmingReason(row, nowMs, session) !== 'orphaned') return false;
  return gate();
}

/** Minimal session repo needed to atomically fence a lease during reap. */
export interface SessionLeaseCasRepo {
  updateWhere(
    id: string,
    predicate: { leaseToken?: string | null; leaseExpiresAt?: Date | string | null },
    updates: { leaseToken: null; leaseExpiresAt: null },
  ): Promise<{ matched: boolean }>;
}

/**
 * Atomic reap gate. Clears the observed (expired) session lease with a single CAS keyed
 * on BOTH the observed `leaseToken` AND `leaseExpiresAt`. A concurrent renewal always bumps
 * `leaseExpiresAt` (keeping the token), so the CAS misses and returns `false` → the live
 * confirm is NOT reaped. This closes the read→reap window with no separate fresh read and
 * no fencing column. Returns `true` (safe to reap) when there is no lease token to fence.
 */
export async function fenceExpiredSessionLease(
  sessions: SessionLeaseCasRepo,
  sessionId: string,
  observed: SessionLeaseSnapshot,
): Promise<boolean> {
  if (!observed.leaseToken) return true;
  const cas = await sessions.updateWhere(
    sessionId,
    {
      leaseToken: observed.leaseToken,
      leaseExpiresAt: (observed.leaseExpiresAt ?? null) as Date | string | null,
    },
    { leaseToken: null, leaseExpiresAt: null },
  );
  return cas.matched;
}

/** In-memory / store-local reap: mutates `row` when stale. Returns true if reaped. */
export function reapStaleConfirmingRowInPlace(
  row: ChatPendingActionV2,
  nowIso: string,
  session: SessionLeaseSnapshot,
): boolean {
  const reason = staleConfirmingReason(row, new Date(nowIso).getTime(), session);
  if (!reason) return false;
  row.status = terminalStatusForStaleConfirming();
  row.completedAt = nowIso;
  return true;
}
