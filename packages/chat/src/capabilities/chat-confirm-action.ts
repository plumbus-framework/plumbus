import type { CapabilityContract } from '@plumbus/core';
import { defineCapability, executeCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { chatActionConfirmedEvent, chatActionRejectedEvent } from '../events/chat-events.js';
import {
  assertChatStorageSupported,
  createChatConversationStore,
} from '../runtime/chat-conversation-store.js';
import { rejectPending } from '../runtime/pending-actions.js';

export const chatConfirmAction = defineCapability({
  name: 'chatConfirmAction',
  kind: 'action',
  domain: 'chat',
  description: 'Confirm or reject a pending chat action',

  input: z.object({
    actionId: z.string().uuid(),
    chatName: z.string(),
    decision: z.enum(['confirm', 'reject']),
    // Binding proof re-verified atomically at claim time (C4). Client-supplied,
    // used ONLY as match keys — never to drive execution (C3).
    inputSchemaHash: z.string(),
    toolBindingHash: z.string(),
    // Route sets true for Path B tools and for Path A when
    // policy.action.frameworkExecuteOnConfirm === true; false = decision-only.
    execute: z.boolean(),
  }),

  output: z.object({
    decisionRecorded: z.boolean(),
    pendingStatus: z.enum(['rejected', 'confirmed', 'failed', 'indeterminate', 'expired']),
    executionStatus: z.enum(['not_requested', 'succeeded', 'failed', 'indeterminate']),
    // ChatEvent[] for the HTTP layer to stream (at minimum confirmation.resolved).
    events: z.array(z.unknown()),
  }),

  access: {},
  effects: {
    data: ['chat:write'],
    events: [chatActionConfirmedEvent.name, chatActionRejectedEvent.name],
    external: [],
    ai: false,
  },

  async handler(ctx, input) {
    assertChatStorageSupported(ctx);
    const store = createChatConversationStore(ctx);
    const sessions = (ctx.data as Record<string, unknown>).ChatSession as {
      findById(id: string): Promise<{ userId: string; revision: number } | null>;
    };
    const pendingRepo = (ctx.data as Record<string, unknown>).ChatPendingAction as {
      findById(id: string): Promise<{ sessionId: string } | null>;
    };

    // Ownership before anything else (non-owners get 404-equivalent).
    const row = await pendingRepo.findById(input.actionId);
    if (!row)
      throw ctx.errors.notFound('Pending action not found', {
        code: 'chat.action_not_found',
        actionId: input.actionId,
      });
    const session = await sessions.findById(row.sessionId);
    const ownerUserId = (ctx.auth as { userId?: string }).userId ?? '';
    if (!session || session.userId !== ownerUserId) {
      throw ctx.errors.notFound('Pending action not found', {
        code: 'chat.action_not_found',
        actionId: input.actionId,
      });
    }

    // ── Reject path (decision-only, single-winner CAS) ──
    if (input.decision === 'reject') {
      const outcome = await rejectPending(ctx, {
        actionId: input.actionId,
        ownerUserId,
        sessionUserId: session.userId,
      });
      if (outcome.rejected) {
        await ctx.events.emit(chatActionRejectedEvent.name, {
          actionId: input.actionId,
          capabilityName: outcome.capabilityName,
        });
        return {
          decisionRecorded: true,
          pendingStatus: 'rejected' as const,
          executionStatus: 'not_requested' as const,
          events: [
            {
              type: 'confirmation.resolved',
              actionId: input.actionId,
              decision: 'reject',
              pendingStatus: 'rejected',
              executionStatus: 'not_requested',
            },
          ],
        };
      }
      if (outcome.reason === 'busy') {
        throw ctx.errors.conflict('Pending action is being confirmed', {
          code: 'chat.session_busy',
          actionId: input.actionId,
        });
      }
      // not_found / already_terminal → nothing to reject.
      throw ctx.errors.notFound('Pending action not found', {
        code: 'chat.action_not_found',
        actionId: input.actionId,
      });
    }

    // ── Confirm path ──
    // Lease ownerToken MUST equal the claim attemptId so the confirming-reaper's
    // liveness proxy (leaseToken === attemptId) recognizes this confirm as in-flight,
    // matching resume-after-confirm. Using distinct tokens would let a concurrent /turn
    // reap this live confirm when the transactional-outbox is disabled.
    const attemptId = crypto.randomUUID();
    const leaseRes = await store.acquireSessionMutation({
      sessionId: row.sessionId,
      ownerToken: attemptId,
      leaseMs: 30_000,
    });
    if (!leaseRes.acquired) {
      throw ctx.errors.conflict('Session is busy', {
        code: 'chat.session_busy',
        actionId: input.actionId,
      });
    }
    const lease = leaseRes.lease;

    // Keep the 30s lease alive across a long-running executeCapability so a concurrent
    // /turn's confirming-reaper does not reap this live confirm.
    // Gated on being OUTSIDE a transaction scope: with the default transactional-outbox the
    // whole handler is one uncommitted tx (the confirming row is invisible to the reaper
    // until commit, so renewal is moot) AND every store call shares the tx connection (a
    // timer-fired query would race it). Only with `transactionalOutbox: false` — where writes
    // commit incrementally, the row is visible, and each store call uses its own connection —
    // does renewal both matter and stay safe.
    const renewable = !ctx.__runtime?.transactionScope;
    let leaseLost = false;
    const renewLease = async () => {
      if (leaseLost) return;
      try {
        const res = await store.renewSessionMutation({
          sessionId: row.sessionId,
          leaseToken: lease.leaseToken,
          leaseMs: 30_000,
        });
        if (!res.renewed) {
          leaseLost = true;
          ctx.logger?.warn?.('chatConfirmAction lost its session lease during execution', {
            sessionId: row.sessionId,
            actionId: input.actionId,
          });
        }
      } catch (err) {
        ctx.logger?.warn?.('chatConfirmAction lease renewal failed', {
          sessionId: row.sessionId,
          actionId: input.actionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const renewTimer = renewable
      ? setInterval(() => {
          void renewLease();
        }, 15_000)
      : undefined;

    try {
      const now = ctx.time.now().toISOString();
      const claim = await store.claimPending({
        actionId: input.actionId,
        owner: ctx.auth,
        chatName: input.chatName,
        inputSchemaHash: input.inputSchemaHash,
        toolBindingHash: input.toolBindingHash,
        attemptId,
        now,
      });

      if (claim.outcome === 'not_found') {
        throw ctx.errors.notFound('Pending action not found', {
          code: 'chat.action_not_found',
          actionId: input.actionId,
        });
      }
      if (claim.outcome === 'already_claimed') {
        throw ctx.errors.conflict('Pending action already claimed', {
          code: 'chat.action_already_claimed',
          actionId: input.actionId,
        });
      }
      if (claim.outcome === 'stale') {
        throw ctx.errors.conflict('Session revision changed since proposal', {
          code: 'chat.confirm_stale',
          actionId: input.actionId,
        });
      }
      if (claim.outcome === 'binding_changed') {
        throw ctx.errors.conflict('Binding no longer matches the proposal', {
          code: 'chat.binding_changed',
          actionId: input.actionId,
        });
      }
      if (claim.outcome === 'expired') {
        return {
          decisionRecorded: true,
          pendingStatus: 'expired' as const,
          executionStatus: 'not_requested' as const,
          events: [
            {
              type: 'confirmation.resolved',
              actionId: input.actionId,
              decision: 'confirm',
              pendingStatus: 'expired',
              executionStatus: 'not_requested',
            },
          ],
        };
      }

      const pending = claim.pending;

      // Decision-only (Path A with frameworkExecuteOnConfirm=false): mark confirmed, no pipeline.
      if (!input.execute) {
        await store.completePending({
          actionId: input.actionId,
          attemptId,
          lease,
          expectedRevision: lease.sessionRevision,
          terminalStatus: 'confirmed',
          completedAt: ctx.time.now().toISOString(),
        });
        await ctx.events.emit(chatActionConfirmedEvent.name, {
          actionId: input.actionId,
          capabilityName: pending.capabilityName, // from STORAGE, not client
        });
        return {
          decisionRecorded: true,
          pendingStatus: 'confirmed' as const,
          executionStatus: 'not_requested' as const,
          events: [
            {
              type: 'confirmation.resolved',
              actionId: input.actionId,
              decision: 'confirm',
              pendingStatus: 'confirmed',
              executionStatus: 'not_requested',
            },
          ],
        };
      }

      // D4 invocation path: resolve + executeCapability(cap, ctx, pending.input).
      const cap = ctx.__runtime?.resolveCapability?.(pending.capabilityName);
      if (!cap) {
        await store.completePending({
          actionId: input.actionId,
          attemptId,
          lease,
          expectedRevision: lease.sessionRevision,
          terminalStatus: 'failed',
          completedAt: ctx.time.now().toISOString(),
        });
        throw ctx.errors.conflict('Configured capability cannot be resolved', {
          code: 'chat.tool_unknown_capability',
          actionId: input.actionId,
        });
      }

      await store.markExecutionStarted({
        actionId: input.actionId,
        attemptId,
        executionStartedAt: ctx.time.now().toISOString(),
      });

      // executeCapability runs evaluateAccess(cap.access, ctx.auth) internally (D4).
      const result = await executeCapability(
        cap as CapabilityContract,
        ctx,
        pending.input, // normalized value from storage (C3)
      );

      if (result.success) {
        await store.completePending({
          actionId: input.actionId,
          attemptId,
          lease,
          expectedRevision: lease.sessionRevision,
          terminalStatus: 'confirmed',
          completedAt: ctx.time.now().toISOString(),
        });
        await ctx.events.emit(chatActionConfirmedEvent.name, {
          actionId: input.actionId,
          capabilityName: pending.capabilityName,
        });
        return {
          decisionRecorded: true,
          pendingStatus: 'confirmed' as const,
          executionStatus: 'succeeded' as const,
          events: [
            {
              type: 'confirmation.resolved',
              actionId: input.actionId,
              decision: 'confirm',
              pendingStatus: 'confirmed',
              executionStatus: 'succeeded',
            },
          ],
        };
      }

      // Failure — map access-denied vs generic failure.
      await store.completePending({
        actionId: input.actionId,
        attemptId,
        lease,
        expectedRevision: lease.sessionRevision,
        terminalStatus: 'failed',
        completedAt: ctx.time.now().toISOString(),
      });
      const failCode =
        result.error?.code === 'forbidden' ? 'chat.tool_access_denied' : 'chat.tool_failed';
      return {
        decisionRecorded: true,
        pendingStatus: 'failed' as const,
        executionStatus: 'failed' as const,
        events: [
          {
            type: 'confirmation.resolved',
            actionId: input.actionId,
            decision: 'confirm',
            pendingStatus: 'failed',
            executionStatus: 'failed',
          },
          {
            type: 'tool.failed',
            toolCallId: input.actionId,
            name: pending.capabilityName,
            kind: 'capability',
            code: failCode,
            message: result.error?.message ?? 'Capability failed',
          },
        ],
      };
    } finally {
      if (renewTimer) clearInterval(renewTimer);
      await store.releaseSessionMutation({
        sessionId: row.sessionId,
        leaseToken: lease.leaseToken,
      });
    }
  },
});
