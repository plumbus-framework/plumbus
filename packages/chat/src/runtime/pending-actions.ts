import type { ExecutionContext } from '@plumbus/core';
import type { ConditionalUpdateResult } from '@plumbus/core';
import { chatSessionRepo } from '../internal/chat-repos.js';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import {
  confirmingReapPredicate,
  fenceExpiredSessionLease,
  sessionLeaseForConfirmingRow,
  shouldReapConfirming,
  terminalStatusForStaleConfirming,
} from './confirming-reaper.js';

type PendingRepo = {
  findById(id: string): Promise<ChatPendingActionV2 | null>;
  findMany(query?: Partial<ChatPendingActionV2>): Promise<ChatPendingActionV2[]>;
  updateWhere(
    id: string,
    predicate: Partial<ChatPendingActionV2>,
    updates: Partial<ChatPendingActionV2>,
  ): Promise<ConditionalUpdateResult<ChatPendingActionV2>>;
};

function pendingRepo(ctx: ExecutionContext): PendingRepo {
  return (ctx.data as Record<string, unknown>).ChatPendingAction as PendingRepo;
}

export type LivePendingCheck =
  | { blocked: false }
  | {
      blocked: true;
      code: 'chat.pending_action_exists' | 'chat.session_busy';
      actionId: string;
      expiresAt: string;
    };

/**
 * C5 existing-pending rule. Checked BEFORE scope/provider work on every /turn.
 *  - status 'confirming', in-flight     → chat.session_busy (409)
 *  - status 'confirming', stale/expired → atomically terminalize, continue
 *  - status 'pending', not expired      → chat.pending_action_exists (409)
 *  - status 'pending', expired          → atomically terminalize (pending→expired), continue
 */
export async function checkLivePending(
  ctx: ExecutionContext,
  sessionId: string,
): Promise<LivePendingCheck> {
  const repo = pendingRepo(ctx);
  const rows = await repo.findMany({ sessionId });
  const sessions = chatSessionRepo(ctx);
  const loadSessionLease = async () => {
    const sessionRow = await sessions.findById(sessionId);
    return sessionRow ?? { leaseToken: null, leaseExpiresAt: null };
  };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // If any row will need a conditional-write (reap a stale confirming row, or expire a
  // lapsed pending), fail closed with a clear chat.storage_unsupported error when the
  // store lacks updateWhere — e.g. a new @plumbus/chat resolved against an older
  // @plumbus/core predating Repository.updateWhere — instead of a raw "not a function".
  const needsConditionalWrite = rows.some(
    (r) =>
      r.status === 'confirming' ||
      (r.status === 'pending' && new Date(r.expiresAt).getTime() <= now),
  );
  if (needsConditionalWrite) {
    const probe = (ctx.data as Record<string, unknown>).ChatPendingAction as
      | { updateWhere?: unknown }
      | undefined;
    if (!probe || typeof probe.updateWhere !== 'function') {
      throw ctx.errors.internal('Chat storage adapter lacks a conditional-write path', {
        code: 'chat.storage_unsupported',
      });
    }
  }
  for (const row of rows) {
    if (row.status === 'confirming') {
      const sessionLease = await sessionLeaseForConfirmingRow(row, loadSessionLease, now);
      const reap = await shouldReapConfirming(row, now, sessionLease, () =>
        fenceExpiredSessionLease(sessions, sessionId, sessionLease),
      );
      if (reap) {
        await repo.updateWhere(row.id, confirmingReapPredicate(row), {
          status: terminalStatusForStaleConfirming(),
          completedAt: nowIso,
        });
        continue;
      }
      return {
        blocked: true,
        code: 'chat.session_busy',
        actionId: row.id,
        expiresAt: row.expiresAt,
      };
    }
    if (row.status === 'pending') {
      if (new Date(row.expiresAt).getTime() <= now) {
        await repo.updateWhere(
          row.id,
          { status: 'pending' },
          { status: 'expired', completedAt: new Date(now).toISOString() },
        );
        continue;
      }
      return {
        blocked: true,
        code: 'chat.pending_action_exists',
        actionId: row.id,
        expiresAt: row.expiresAt,
      };
    }
  }
  return { blocked: false };
}

/** Terminalize a confirming row after resume/confirm failure (best-effort CAS). */
export async function terminalizeConfirmingRow(
  ctx: ExecutionContext,
  args: {
    actionId: string;
    attemptId?: string;
    terminalStatus: 'failed' | 'expired' | 'indeterminate';
    completedAt: string;
  },
): Promise<void> {
  const repo = pendingRepo(ctx);
  const predicate: Partial<ChatPendingActionV2> = args.attemptId
    ? { status: 'confirming', attemptId: args.attemptId }
    : { status: 'confirming' };
  await repo.updateWhere(args.actionId, predicate, {
    status: args.terminalStatus,
    completedAt: args.completedAt,
  });
}

export type RejectPendingResult =
  | { rejected: true; capabilityName: string }
  | { rejected: false; reason: 'not_found' | 'already_terminal' | 'busy' };

/**
 * Reject a pending action. Ownership is enforced by the caller (session lookup).
 * Single-winner CAS pending→rejected; a 'confirming' row is busy (in flight).
 */
export async function rejectPending(
  ctx: ExecutionContext,
  args: { actionId: string; ownerUserId: string; sessionUserId: string | null },
): Promise<RejectPendingResult> {
  const repo = pendingRepo(ctx);
  const row = await repo.findById(args.actionId);
  if (!row) return { rejected: false, reason: 'not_found' };
  if (args.sessionUserId == null || args.sessionUserId !== args.ownerUserId) {
    return { rejected: false, reason: 'not_found' };
  }
  if (row.status === 'confirming') return { rejected: false, reason: 'busy' };
  if (row.status !== 'pending') return { rejected: false, reason: 'already_terminal' };
  const cas = await repo.updateWhere(
    args.actionId,
    { status: 'pending' },
    { status: 'rejected', completedAt: new Date().toISOString() },
  );
  if (!cas.matched) return { rejected: false, reason: 'busy' };
  return { rejected: true, capabilityName: row.capabilityName };
}
