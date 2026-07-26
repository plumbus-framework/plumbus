import type { AuthContext, ConditionalUpdateResult, ExecutionContext } from '@plumbus/core';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import type { ChatSourceRef } from '../types/context.js';
import type { ToolExecutionRecord } from '../types/tool.js';
import type { ChatSessionRow, ChatTurnRow } from '../types/session.js';
import {
  confirmingReapPredicate,
  fenceExpiredSessionLease,
  sessionLeaseForConfirmingRow,
  shouldReapConfirming,
  terminalStatusForStaleConfirming,
} from './confirming-reaper.js';

// ── Appendix A.9 canonical contracts ──

/** Row shape appended by store mutations. Ordinals + revision are assigned by the store. */
export interface ChatTurnWrite {
  role: 'user' | 'assistant' | 'system';
  content: string;
  inScope: boolean;
  refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
  sources: ChatSourceRef[];
  logicalTurnId: string;
  continuationOfTurnId?: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  model: string;
  latencyMs: number;
  toolsExecuted?: ToolExecutionRecord[];
  actionRequested?: unknown;
  actionConfirmed?: boolean;
}

export interface SessionMutationLease {
  sessionId: string;
  leaseToken: string;
  acquiredAt: string;
  expiresAt: string;
  /** Authoritative session revision observed under the lease. */
  sessionRevision: number;
}

export type AcquireSessionMutationResult =
  | { acquired: true; lease: SessionMutationLease }
  | { acquired: false; reason: 'session_busy'; heldUntil: string };

export type ClaimPendingResult =
  | { outcome: 'claimed'; pending: ChatPendingActionV2 }
  | { outcome: 'not_found' } //        → chat.action_not_found (404)
  | { outcome: 'already_claimed' } //  → chat.action_already_claimed (409)
  | { outcome: 'expired' } //          → chat.action_expired (410)
  | { outcome: 'stale' } //            revision !== expectedSessionRevision → chat.confirm_stale (409)
  | { outcome: 'binding_changed' }; // → chat.binding_changed (409)

/**
 * D1: full lease-based store. Steps §12.6(4–6) occur in one transaction or one
 * semantically equivalent conditional (CAS) store operation. Adapters that cannot
 * provide a conditional/transactional write path fail closed at startup with
 * 'chat.storage_unsupported' (see assertChatStorageSupported).
 */
export interface ChatConversationStore {
  acquireSessionMutation(args: {
    sessionId: string;
    ownerToken: string;
    leaseMs: number;
  }): Promise<AcquireSessionMutationResult>;

  renewSessionMutation(args: {
    sessionId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<{ renewed: boolean; expiresAt?: string }>;

  releaseSessionMutation(args: { sessionId: string; leaseToken: string }): Promise<void>;

  /** Atomic single-request commit: 1..2 turn rows sharing logicalTurnId; revision++ once. */
  commitTurn(args: {
    lease: SessionMutationLease;
    expectedRevision: number;
    turns: ChatTurnWrite[];
  }): Promise<{ committedRevision: number; ordinals: number[] }>;

  /** §12.4 proposal transaction: user turn + assistant confirmation turn + pending row + revision++;
   *  enforces unique (sessionId, ordinal). */
  commitProposal(args: {
    lease: SessionMutationLease;
    expectedRevision: number;
    userTurn: ChatTurnWrite;
    assistantTurn: ChatTurnWrite;
    pending: ChatPendingActionV2;
  }): Promise<{ committedRevision: number; ordinals: number[]; actionId: string }>;

  /** §12.6 atomic claim: verify owner/chatName/inputSchemaHash/toolBindingHash/expiry/status==='pending'
   *  and revision===expectedSessionRevision, then pending→confirming with a new attemptId. */
  claimPending(args: {
    actionId: string;
    owner: AuthContext;
    chatName: string;
    inputSchemaHash: string;
    toolBindingHash: string;
    attemptId: string;
    now: string;
  }): Promise<ClaimPendingResult>;

  /** §12.6 step 7: stamp executionStartedAt immediately before the capability pipeline. */
  markExecutionStarted(args: {
    actionId: string;
    attemptId: string;
    executionStartedAt: string;
  }): Promise<void>;

  /** §12.7/§12.10: persist terminal execution state; on confirmed success append the resume turn; revision++. */
  completePending(args: {
    actionId: string;
    attemptId: string;
    lease: SessionMutationLease;
    expectedRevision: number;
    terminalStatus: 'confirmed' | 'failed' | 'indeterminate';
    completedAt: string;
    resumeTurn?: ChatTurnWrite;
  }): Promise<{ committedRevision: number }>;

  /** C5 pre-turn probe; an expired pending is atomically terminalized and reported as 'none'. */
  inspectSession(
    sessionId: string,
    now: string,
  ): Promise<{
    pending: 'none' | 'pending' | 'confirming';
    actionId?: string;
    expiresAt?: string;
  }>;

  /** Ownership-enforced NON-mutating read (owner-miss => { found:false }). */
  peekPending(args: {
    actionId: string;
    owner: AuthContext;
    chatName: string;
    now: string;
  }): Promise<
    | { found: false; reason?: 'not_found' | 'expired' | 'wrong_owner' | 'wrong_status' }
    | { found: true; pending: ChatPendingActionV2 }
  >;

  rejectPending(args: {
    actionId: string;
    owner: AuthContext;
    chatName: string;
    now: string;
  }): Promise<
    | { outcome: 'rejected'; capabilityName: string }
    | { outcome: 'not_found' }
    | { outcome: 'already_claimed' }
    | { outcome: 'expired' }
  >;

  /** Nested confirm: finalize original 'confirmed' + append continuation turn + insert new pending. */
  commitResumeProposal(args: {
    lease: SessionMutationLease;
    expectedRevision: number;
    finalizeActionId: string;
    attemptId: string;
    completedAt: string;
    continuationTurn: ChatTurnWrite;
    newPending: ChatPendingActionV2;
  }): Promise<{ committedRevision: number; ordinals: number[]; actionId: string }>;
}

// ── Fail-closed startup check (D1, C8: 'chat.storage_unsupported') ──

/**
 * Throws a structured 'chat.storage_unsupported' error when the wired DataService
 * cannot provide the conditional-write path this store requires (i.e. the chat
 * repositories lack `updateWhere`). Server/worker bootstrap always satisfies this;
 * custom adapters that don't must fail closed BEFORE any tool/confirmation work.
 */
export function assertChatStorageSupported(ctx: ExecutionContext): void {
  const probe = (ctx.data as Record<string, unknown>).ChatSession as
    | { updateWhere?: unknown }
    | undefined;
  if (!probe || typeof probe.updateWhere !== 'function') {
    throw ctx.errors.internal('Chat storage adapter lacks a conditional-write path', {
      code: 'chat.storage_unsupported',
    });
  }
}

// ── ctx-backed store (drizzle prod + createTestContext in-memory) ──

type SessionRepo = {
  findById(id: string): Promise<ChatSessionRow | null>;
  updateWhere(
    id: string,
    predicate: Partial<ChatSessionRow>,
    updates: Partial<ChatSessionRow>,
  ): Promise<ConditionalUpdateResult<ChatSessionRow>>;
};
type TurnRepo = {
  create(data: Omit<ChatTurnRow, 'id'> & { id?: string }): Promise<ChatTurnRow>;
  findMany(query?: Partial<ChatTurnRow>): Promise<ChatTurnRow[]>;
};
type PendingRepo = {
  create(data: ChatPendingActionV2): Promise<ChatPendingActionV2>;
  findById(id: string): Promise<ChatPendingActionV2 | null>;
  findMany(query?: Partial<ChatPendingActionV2>): Promise<ChatPendingActionV2[]>;
  updateWhere(
    id: string,
    predicate: Partial<ChatPendingActionV2>,
    updates: Partial<ChatPendingActionV2>,
  ): Promise<ConditionalUpdateResult<ChatPendingActionV2>>;
};

interface Repos {
  sessions: SessionRepo;
  turns: TurnRepo;
  pending: PendingRepo;
}

function repos(data: ExecutionContext['data']): Repos {
  const map = data as Record<string, unknown>;
  return {
    sessions: map.ChatSession as SessionRepo,
    turns: map.ChatTurn as TurnRepo,
    pending: map.ChatPendingAction as PendingRepo,
  };
}

/**
 * Run `fn` atomically. Uses the enclosing capability transaction scope when present
 * (chatConfirmAction is kind:'action'), else opens one via withTransaction, else runs
 * on ctx.data directly (single-connection tests). CAS methods provide the authoritative
 * concurrency guarantees regardless of which branch is taken.
 */
async function runAtomic<T>(
  ctx: ExecutionContext,
  fn: (data: ExecutionContext['data']) => Promise<T>,
): Promise<T> {
  const scope = ctx.__runtime?.transactionScope;
  if (scope) return fn(scope.data);
  const wt = ctx.__runtime?.withTransaction;
  if (wt) return wt((s) => fn(s.data));
  return fn(ctx.data);
}

export function createChatConversationStore(ctx: ExecutionContext): ChatConversationStore {
  assertChatStorageSupported(ctx);

  function isLeaseActive(row: ChatSessionRow, now: number): boolean {
    if (!row.leaseToken || !row.leaseExpiresAt) return false;
    return new Date(row.leaseExpiresAt).getTime() > now;
  }

  async function assignOrdinals(
    turns: TurnRepo,
    sessionId: string,
    count: number,
  ): Promise<number[]> {
    const existing = await turns.findMany({ sessionId });
    const base = existing.length;
    return Array.from({ length: count }, (_, i) => base + i);
  }

  return {
    // 1. read session; 2. if lease active → session_busy; 3. CAS on observed
    //    leaseToken (null → IS NULL) to become the single winner.
    async acquireSessionMutation({ sessionId, ownerToken, leaseMs }) {
      const { sessions } = repos(ctx.data);
      const row = await sessions.findById(sessionId);
      if (!row) throw ctx.errors.notFound('Session not found', { sessionId });
      const now = Date.now();
      if (isLeaseActive(row, now)) {
        return {
          acquired: false,
          reason: 'session_busy',
          heldUntil: new Date(row.leaseExpiresAt as string | Date).toISOString(),
        };
      }
      const expiresAt = new Date(now + leaseMs);
      const cas = await sessions.updateWhere(
        sessionId,
        { leaseToken: row.leaseToken ?? null },
        { leaseToken: ownerToken, leaseExpiresAt: expiresAt },
      );
      if (!cas.matched || !cas.row) {
        return { acquired: false, reason: 'session_busy', heldUntil: new Date(now).toISOString() };
      }
      return {
        acquired: true,
        lease: {
          sessionId,
          leaseToken: ownerToken,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: expiresAt.toISOString(),
          sessionRevision: cas.row.revision,
        },
      };
    },

    async renewSessionMutation({ sessionId, leaseToken, leaseMs }) {
      const { sessions } = repos(ctx.data);
      const expiresAt = new Date(Date.now() + leaseMs);
      const cas = await sessions.updateWhere(
        sessionId,
        { leaseToken },
        { leaseExpiresAt: expiresAt },
      );
      return cas.matched
        ? { renewed: true, expiresAt: expiresAt.toISOString() }
        : { renewed: false };
    },

    async releaseSessionMutation({ sessionId, leaseToken }) {
      const { sessions } = repos(ctx.data);
      await sessions.updateWhere(
        sessionId,
        { leaseToken },
        { leaseToken: null, leaseExpiresAt: null },
      );
    },

    // Atomic: revision CAS first (guards concurrency + confirms lease), then insert turns.
    async commitTurn({ lease, expectedRevision, turns }) {
      return runAtomic(ctx, async (data) => {
        const r = repos(data);
        const committedRevision = expectedRevision + 1;
        const bump = await r.sessions.updateWhere(
          lease.sessionId,
          { revision: expectedRevision, leaseToken: lease.leaseToken },
          { revision: committedRevision, lastTurnAt: new Date() },
        );
        if (!bump.matched) {
          throw ctx.errors.conflict('Session mutation lost', {
            code: 'chat.session_busy',
            sessionId: lease.sessionId,
          });
        }
        const ordinals = await assignOrdinals(r.turns, lease.sessionId, turns.length);
        for (let i = 0; i < turns.length; i++) {
          await r.turns.create(
            turnRow(lease.sessionId, ordinals[i] ?? 0, turns[i] as ChatTurnWrite, ctx),
          );
        }
        return { committedRevision, ordinals };
      });
    },

    // §12.4: revision CAS, then user turn + assistant confirmation turn + pending row.
    async commitProposal({ lease, expectedRevision, userTurn, assistantTurn, pending }) {
      return runAtomic(ctx, async (data) => {
        const r = repos(data);
        const committedRevision = expectedRevision + 1;
        const bump = await r.sessions.updateWhere(
          lease.sessionId,
          { revision: expectedRevision, leaseToken: lease.leaseToken },
          { revision: committedRevision, lastTurnAt: new Date() },
        );
        if (!bump.matched) {
          throw ctx.errors.conflict('Session mutation lost', {
            code: 'chat.session_busy',
            sessionId: lease.sessionId,
          });
        }
        const ordinals = await assignOrdinals(r.turns, lease.sessionId, 2);
        await r.turns.create(turnRow(lease.sessionId, ordinals[0] ?? 0, userTurn, ctx));
        await r.turns.create(turnRow(lease.sessionId, ordinals[1] ?? 1, assistantTurn, ctx));
        await r.pending.create(pending);
        return { committedRevision, ordinals, actionId: pending.id };
      });
    },

    // §12.6: owner+chatName+expiry+binding+revision checks, then status CAS pending→confirming.
    async claimPending({
      actionId,
      owner,
      chatName,
      inputSchemaHash,
      toolBindingHash,
      attemptId,
      now,
    }) {
      const r = repos(ctx.data);
      const row = await r.pending.findById(actionId);
      if (!row) return { outcome: 'not_found' };
      const session = await r.sessions.findById(row.sessionId);
      // Ownership + chatName before any mutation so non-owners cannot probe/expire.
      if (!session || session.userId !== owner.userId || session.chatName !== chatName) {
        return { outcome: 'not_found' };
      }
      if (row.inputSchemaHash !== inputSchemaHash || row.toolBindingHash !== toolBindingHash) {
        return { outcome: 'binding_changed' };
      }
      if (session.revision !== row.expectedSessionRevision) {
        return { outcome: 'stale' };
      }
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        // Atomically terminalize the expired pending, then report expired.
        await r.pending.updateWhere(
          actionId,
          { status: 'pending' },
          { status: 'expired', completedAt: now },
        );
        return { outcome: 'expired' };
      }
      const cas = await r.pending.updateWhere(
        actionId,
        { status: 'pending' },
        { status: 'confirming', attemptId, claimedAt: now },
      );
      if (!cas.matched || !cas.row) return { outcome: 'already_claimed' };
      return { outcome: 'claimed', pending: cas.row };
    },

    async markExecutionStarted({ actionId, attemptId, executionStartedAt }) {
      const r = repos(ctx.data);
      await r.pending.updateWhere(
        actionId,
        { status: 'confirming', attemptId },
        { executionStartedAt },
      );
    },

    // §12.7/§12.10: status CAS confirming→terminal; on confirmed + resumeTurn, revision CAS + append.
    async completePending({
      actionId,
      attemptId,
      lease,
      expectedRevision,
      terminalStatus,
      completedAt,
      resumeTurn,
    }) {
      return runAtomic(ctx, async (data) => {
        const r = repos(data);
        const done = await r.pending.updateWhere(
          actionId,
          { status: 'confirming', attemptId },
          { status: terminalStatus, completedAt },
        );
        if (!done.matched) {
          throw ctx.errors.conflict('Pending action not claimable', {
            code: 'chat.action_already_claimed',
            actionId,
          });
        }
        let committedRevision = expectedRevision;
        if (terminalStatus === 'confirmed' && resumeTurn) {
          committedRevision = expectedRevision + 1;
          const bump = await r.sessions.updateWhere(
            lease.sessionId,
            { revision: expectedRevision, leaseToken: lease.leaseToken },
            { revision: committedRevision, lastTurnAt: new Date() },
          );
          if (!bump.matched) {
            throw ctx.errors.conflict('Session mutation lost', {
              code: 'chat.session_busy',
              sessionId: lease.sessionId,
            });
          }
          const [ordinal] = await assignOrdinals(r.turns, lease.sessionId, 1);
          await r.turns.create(turnRow(lease.sessionId, ordinal ?? 0, resumeTurn, ctx));
        }
        return { committedRevision };
      });
    },

    async inspectSession(sessionId, now) {
      const r = repos(ctx.data);
      const rows = await r.pending.findMany({ sessionId });
      const nowMs = new Date(now).getTime();
      const loadSessionLease = () =>
        r.sessions
          .findById(sessionId)
          .then((sessionRow) => sessionRow ?? { leaseToken: null, leaseExpiresAt: null });
      for (const row of rows) {
        if (row.status === 'confirming') {
          const sessionLease = await sessionLeaseForConfirmingRow(row, loadSessionLease, nowMs);
          const reap = await shouldReapConfirming(row, nowMs, sessionLease, () =>
            fenceExpiredSessionLease(r.sessions, sessionId, sessionLease),
          );
          if (reap) {
            await r.pending.updateWhere(row.id, confirmingReapPredicate(row), {
              status: terminalStatusForStaleConfirming(),
              completedAt: now,
            });
            continue;
          }
          return { pending: 'confirming', actionId: row.id, expiresAt: row.expiresAt };
        }
        if (row.status === 'pending') {
          if (new Date(row.expiresAt).getTime() <= nowMs) {
            await r.pending.updateWhere(
              row.id,
              { status: 'pending' },
              { status: 'expired', completedAt: now },
            );
            continue;
          }
          return { pending: 'pending', actionId: row.id, expiresAt: row.expiresAt };
        }
      }
      return { pending: 'none' };
    },

    async peekPending({ actionId, owner, chatName, now }) {
      const r = repos(ctx.data);
      const row = await r.pending.findById(actionId);
      if (!row) return { found: false, reason: 'not_found' };
      const session = await r.sessions.findById(row.sessionId);
      if (!session || session.userId !== owner.userId || session.chatName !== chatName) {
        return { found: false, reason: 'wrong_owner' };
      }
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        return { found: false, reason: 'expired' };
      }
      if (row.status !== 'pending') return { found: false, reason: 'wrong_status' };
      return { found: true, pending: row };
    },

    async rejectPending({ actionId, owner, chatName, now }) {
      const r = repos(ctx.data);
      const row = await r.pending.findById(actionId);
      if (!row) return { outcome: 'not_found' };
      const session = await r.sessions.findById(row.sessionId);
      if (!session || session.userId !== owner.userId || session.chatName !== chatName) {
        return { outcome: 'not_found' };
      }
      if (row.status === 'confirming') return { outcome: 'already_claimed' };
      if (row.status !== 'pending') return { outcome: 'not_found' };
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        await r.pending.updateWhere(
          actionId,
          { status: 'pending' },
          { status: 'expired', completedAt: now },
        );
        return { outcome: 'expired' };
      }
      const cas = await r.pending.updateWhere(
        actionId,
        { status: 'pending' },
        { status: 'rejected', completedAt: now },
      );
      if (!cas.matched) return { outcome: 'already_claimed' };
      return { outcome: 'rejected', capabilityName: row.capabilityName };
    },

    async commitResumeProposal({
      lease,
      expectedRevision,
      finalizeActionId,
      attemptId,
      completedAt,
      continuationTurn,
      newPending,
    }) {
      return runAtomic(ctx, async (data) => {
        const r = repos(data);
        const done = await r.pending.updateWhere(
          finalizeActionId,
          { status: 'confirming', attemptId },
          { status: 'confirmed', completedAt },
        );
        if (!done.matched) {
          throw ctx.errors.conflict('Pending action not claimable', {
            code: 'chat.action_already_claimed',
            actionId: finalizeActionId,
          });
        }
        const committedRevision = expectedRevision + 1;
        const bump = await r.sessions.updateWhere(
          lease.sessionId,
          { revision: expectedRevision, leaseToken: lease.leaseToken },
          { revision: committedRevision, lastTurnAt: new Date() },
        );
        if (!bump.matched) {
          throw ctx.errors.conflict('Session mutation lost', {
            code: 'chat.session_busy',
            sessionId: lease.sessionId,
          });
        }
        const [ordinal] = await assignOrdinals(r.turns, lease.sessionId, 1);
        await r.turns.create(turnRow(lease.sessionId, ordinal ?? 0, continuationTurn, ctx));
        await r.pending.create(newPending);
        return { committedRevision, ordinals: [ordinal ?? 0], actionId: newPending.id };
      });
    },
  };
}

/** Map a ChatTurnWrite to a ChatTurn create payload with an assigned ordinal. */
function turnRow(
  sessionId: string,
  ordinal: number,
  w: ChatTurnWrite,
  ctx: ExecutionContext,
): Omit<ChatTurnRow, 'id'> & { id: string } {
  return {
    id: crypto.randomUUID(),
    sessionId,
    ordinal,
    role: w.role,
    content: w.content,
    inScope: w.inScope,
    refusalReason: w.refusalReason ?? undefined,
    sources: w.sources,
    actionRequested: w.actionRequested as { capabilityName: string; input: unknown } | undefined,
    actionConfirmed: w.actionConfirmed,
    logicalTurnId: w.logicalTurnId,
    continuationOfTurnId: w.continuationOfTurnId,
    toolsExecuted: w.toolsExecuted,
    tokensIn: w.tokensIn,
    tokensOut: w.tokensOut,
    costUsd: w.costUsd,
    model: w.model,
    latencyMs: w.latencyMs,
    recordedAt: ctx.time.now(),
    userId: (ctx.auth as { userId?: string }).userId ?? '',
  };
}
