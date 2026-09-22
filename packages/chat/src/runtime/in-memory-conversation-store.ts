import type { AuthContext } from '@plumbus/core';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import {
  reapStaleConfirmingRowInPlace,
  sessionLeaseForConfirmingRow,
} from './confirming-reaper.js';
import type {
  AcquireSessionMutationResult,
  ChatConversationStore,
  ChatTurnWrite,
  ClaimPendingResult,
} from './chat-conversation-store.js';

interface MemSession {
  id: string;
  userId: string;
  chatName: string;
  revision: number;
  leaseToken: string | null;
  leaseExpiresAt: number | null;
}

/**
 * Standalone Map-backed ChatConversationStore for store-level unit tests that
 * do not stand up an ExecutionContext. Mirrors createChatConversationStore's
 * CAS/revision semantics exactly.
 */
export function createInMemoryChatConversationStore(seed: {
  sessions: Array<{ id: string; userId: string; chatName: string; revision?: number }>;
}): ChatConversationStore & {
  __turns: Array<{ sessionId: string; ordinal: number; write: ChatTurnWrite }>;
  __pending: Map<string, ChatPendingActionV2>;
} {
  const sessions = new Map<string, MemSession>();
  for (const s of seed.sessions) {
    sessions.set(s.id, {
      id: s.id,
      userId: s.userId,
      chatName: s.chatName,
      revision: s.revision ?? 0,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  }
  const turns: Array<{ sessionId: string; ordinal: number; write: ChatTurnWrite }> = [];
  const pending = new Map<string, ChatPendingActionV2>();

  const nextOrdinals = (sessionId: string, n: number): number[] => {
    const base = turns.filter((t) => t.sessionId === sessionId).length;
    return Array.from({ length: n }, (_, i) => base + i);
  };

  return {
    __turns: turns,
    __pending: pending,

    async acquireSessionMutation({
      sessionId,
      ownerToken,
      leaseMs,
    }): Promise<AcquireSessionMutationResult> {
      const s = sessions.get(sessionId);
      if (!s) throw new Error('chat.session_not_found');
      const now = Date.now();
      if (s.leaseToken && s.leaseExpiresAt && s.leaseExpiresAt > now) {
        return {
          acquired: false,
          reason: 'session_busy',
          heldUntil: new Date(s.leaseExpiresAt).toISOString(),
        };
      }
      s.leaseToken = ownerToken;
      s.leaseExpiresAt = now + leaseMs;
      return {
        acquired: true,
        lease: {
          sessionId,
          leaseToken: ownerToken,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(s.leaseExpiresAt).toISOString(),
          sessionRevision: s.revision,
        },
      };
    },

    async renewSessionMutation({ sessionId, leaseToken, leaseMs }) {
      const s = sessions.get(sessionId);
      if (!s || s.leaseToken !== leaseToken) return { renewed: false };
      s.leaseExpiresAt = Date.now() + leaseMs;
      return { renewed: true, expiresAt: new Date(s.leaseExpiresAt).toISOString() };
    },

    async releaseSessionMutation({ sessionId, leaseToken }) {
      const s = sessions.get(sessionId);
      if (s && s.leaseToken === leaseToken) {
        s.leaseToken = null;
        s.leaseExpiresAt = null;
      }
    },

    async commitTurn({ lease, expectedRevision, turns: writes }) {
      const s = sessions.get(lease.sessionId);
      if (!s || s.revision !== expectedRevision || s.leaseToken !== lease.leaseToken) {
        throw new Error('chat.session_busy');
      }
      const ordinals = nextOrdinals(lease.sessionId, writes.length);
      for (let i = 0; i < writes.length; i++) {
        const w = writes[i];
        if (w) turns.push({ sessionId: lease.sessionId, ordinal: ordinals[i] ?? 0, write: w });
      }
      s.revision = expectedRevision + 1;
      return { committedRevision: s.revision, ordinals };
    },

    async commitProposal({ lease, expectedRevision, userTurn, assistantTurn, pending: p }) {
      const s = sessions.get(lease.sessionId);
      if (!s || s.revision !== expectedRevision || s.leaseToken !== lease.leaseToken) {
        throw new Error('chat.session_busy');
      }
      const ordinals = nextOrdinals(lease.sessionId, 2);
      turns.push({ sessionId: lease.sessionId, ordinal: ordinals[0] ?? 0, write: userTurn });
      turns.push({ sessionId: lease.sessionId, ordinal: ordinals[1] ?? 1, write: assistantTurn });
      pending.set(p.id, p);
      s.revision = expectedRevision + 1;
      return { committedRevision: s.revision, ordinals, actionId: p.id };
    },

    async claimPending({
      actionId,
      owner,
      chatName,
      inputSchemaHash,
      toolBindingHash,
      attemptId,
      now,
    }): Promise<ClaimPendingResult> {
      const row = pending.get(actionId);
      if (!row) return { outcome: 'not_found' };
      const s = sessions.get(row.sessionId);
      if (!s || s.userId !== (owner as AuthContext).userId || s.chatName !== chatName) {
        return { outcome: 'not_found' };
      }
      if (row.inputSchemaHash !== inputSchemaHash || row.toolBindingHash !== toolBindingHash) {
        return { outcome: 'binding_changed' };
      }
      if (s.revision !== row.expectedSessionRevision) return { outcome: 'stale' };
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        row.status = 'expired';
        row.completedAt = now;
        return { outcome: 'expired' };
      }
      if (row.status !== 'pending') return { outcome: 'already_claimed' };
      row.status = 'confirming';
      row.attemptId = attemptId;
      row.claimedAt = now;
      return { outcome: 'claimed', pending: row };
    },

    async markExecutionStarted({ actionId, attemptId, executionStartedAt }) {
      const row = pending.get(actionId);
      if (row && row.status === 'confirming' && row.attemptId === attemptId) {
        row.executionStartedAt = executionStartedAt;
      }
    },

    async completePending({
      actionId,
      attemptId,
      lease,
      expectedRevision,
      terminalStatus,
      completedAt,
      resumeTurn,
    }) {
      const row = pending.get(actionId);
      if (!row || row.status !== 'confirming' || row.attemptId !== attemptId) {
        throw new Error('chat.action_already_claimed');
      }
      row.status = terminalStatus;
      row.completedAt = completedAt;
      let committedRevision = expectedRevision;
      if (terminalStatus === 'confirmed' && resumeTurn) {
        const s = sessions.get(lease.sessionId);
        if (!s || s.revision !== expectedRevision || s.leaseToken !== lease.leaseToken) {
          throw new Error('chat.session_busy');
        }
        const [ordinal] = nextOrdinals(lease.sessionId, 1);
        turns.push({ sessionId: lease.sessionId, ordinal: ordinal ?? 0, write: resumeTurn });
        committedRevision = expectedRevision + 1;
        s.revision = committedRevision;
      }
      return { committedRevision };
    },

    async inspectSession(sessionId, now) {
      const nowMs = new Date(now).getTime();
      const loadSessionLease = () => {
        const sessionRow = sessions.get(sessionId);
        return sessionRow ?? { leaseToken: null, leaseExpiresAt: null };
      };
      for (const row of pending.values()) {
        if (row.sessionId !== sessionId) continue;
        if (row.status === 'confirming') {
          const sessionLease = await sessionLeaseForConfirmingRow(row, loadSessionLease, nowMs);
          if (reapStaleConfirmingRowInPlace(row, now, sessionLease)) {
            continue;
          }
          return { pending: 'confirming', actionId: row.id, expiresAt: row.expiresAt };
        }
        if (row.status === 'pending') {
          if (new Date(row.expiresAt).getTime() <= nowMs) {
            row.status = 'expired';
            row.completedAt = now;
            continue;
          }
          return { pending: 'pending', actionId: row.id, expiresAt: row.expiresAt };
        }
      }
      return { pending: 'none' };
    },

    async peekPending({ actionId, owner, chatName, now }) {
      const row = pending.get(actionId);
      if (!row) return { found: false, reason: 'not_found' };
      const s = sessions.get(row.sessionId);
      if (!s || s.userId !== owner.userId || s.chatName !== chatName) {
        return { found: false, reason: 'wrong_owner' };
      }
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        return { found: false, reason: 'expired' };
      }
      if (row.status !== 'pending') return { found: false, reason: 'wrong_status' };
      return { found: true, pending: row };
    },

    async rejectPending({ actionId, owner, chatName, now }) {
      const row = pending.get(actionId);
      if (!row) return { outcome: 'not_found' };
      const s = sessions.get(row.sessionId);
      if (!s || s.userId !== owner.userId || s.chatName !== chatName) {
        return { outcome: 'not_found' };
      }
      if (row.status === 'confirming') return { outcome: 'already_claimed' };
      if (row.status !== 'pending') return { outcome: 'not_found' };
      if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
        row.status = 'expired';
        row.completedAt = now;
        return { outcome: 'expired' };
      }
      row.status = 'rejected';
      row.completedAt = now;
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
      const row = pending.get(finalizeActionId);
      if (!row || row.status !== 'confirming' || row.attemptId !== attemptId) {
        throw new Error('chat.action_already_claimed');
      }
      const s = sessions.get(lease.sessionId);
      if (!s || s.revision !== expectedRevision || s.leaseToken !== lease.leaseToken) {
        throw new Error('chat.session_busy');
      }
      row.status = 'confirmed';
      row.completedAt = completedAt;
      const [ordinal] = nextOrdinals(lease.sessionId, 1);
      turns.push({ sessionId: lease.sessionId, ordinal: ordinal ?? 0, write: continuationTurn });
      pending.set(newPending.id, newPending);
      s.revision = expectedRevision + 1;
      return { committedRevision: s.revision, ordinals: [ordinal ?? 0], actionId: newPending.id };
    },
  };
}
