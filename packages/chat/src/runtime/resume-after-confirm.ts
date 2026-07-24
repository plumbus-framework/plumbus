import type { AuthContext, ChatMessage, ExecutionContext } from '@plumbus/core';
import { executeCapability } from '@plumbus/core';
import { chatActionConfirmedEvent, chatTurnCompletedEvent } from '../events/chat-events.js';
import type { ChatPendingActionV2 } from '../session/pending-action-v2.js';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatSourceRef } from '../types/context.js';
import type { ChatEvent } from '../types/event.js';
import type { ToolExecutionRecord } from '../types/tool.js';
import type {
  ChatConversationStore,
  ChatTurnWrite,
  SessionMutationLease,
} from './chat-conversation-store.js';
import { terminalizeConfirmingRow } from './pending-actions.js';
import { resumeToolLoop } from './run-turn.js';

/** Observation byte cap; truncation preserves a valid JSON envelope. */
const MAX_OBSERVATION_BYTES = 8192;
/** Mutation lease held for the duration of the resume commit. */
const RESUME_LEASE_MS = 30_000;
/** Renew the resume lease halfway through its TTL while work continues. */
const LEASE_RENEW_INTERVAL_MS = 15_000;

function execCtxWithSignal(ctx: ExecutionContext, signal?: AbortSignal): ExecutionContext {
  return signal ? { ...ctx, signal } : ctx;
}

/** Best-effort finalize after execution succeeded but the primary CAS lost (e.g. row reaped). */
async function reconcileConfirmedAfterCasLoss(
  ctx: ExecutionContext,
  store: ChatConversationStore,
  args: {
    actionId: string;
    attemptId: string;
    lease: SessionMutationLease;
    expectedRevision: number;
    completedAt: string;
    resumeTurn?: ChatTurnWrite;
  },
): Promise<void> {
  try {
    await store.completePending({
      actionId: args.actionId,
      attemptId: args.attemptId,
      lease: args.lease,
      expectedRevision: args.expectedRevision,
      terminalStatus: 'confirmed',
      completedAt: args.completedAt,
      resumeTurn: args.resumeTurn,
    });
  } catch {
    await terminalizeConfirmingRow(ctx, {
      actionId: args.actionId,
      attemptId: args.attemptId,
      terminalStatus: 'indeterminate',
      completedAt: args.completedAt,
    }).catch(() => {});
  }
}

/** Appendix A.9 — declared here; re-exported from the package barrel. C6 adds 'expired'. */
export interface ChatConfirmResult {
  decisionRecorded: boolean;
  pendingStatus: 'rejected' | 'confirmed' | 'failed' | 'indeterminate' | 'expired';
  execution: {
    status: 'not_requested' | 'succeeded' | 'failed' | 'indeterminate';
    projection?: unknown;
  };
  resume: {
    status: 'not_requested' | 'completed' | 'failed';
  };
}

export interface ResumeAfterConfirmArgs {
  chat: ChatDefinition;
  store: ChatConversationStore;
  /** The claimed pending (status 'confirming', attemptId set) returned by store.claimPending. */
  pending: ChatPendingActionV2;
  owner: AuthContext;
  emit: (evt: ChatEvent) => void;
  onResult: (result: ChatConfirmResult) => void;
  signal?: AbortSignal;
}

function nowIso(ctx: ExecutionContext): string {
  return new Date(ctx.time.now()).toISOString();
}

function toolKind(name: string): 'capability' | 'flow' {
  return name.startsWith('flow__') ? 'flow' : 'capability';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function safeObservation(payload: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch {
    return JSON.stringify({ ok: false, code: 'chat.tool_failed' });
  }
  if (Buffer.byteLength(text, 'utf8') <= MAX_OBSERVATION_BYTES) return text;
  return JSON.stringify({ ok: true, truncated: true });
}

/**
 * Resume a logical chat turn after its confirm-mode tool has been confirmed and
 * atomically claimed. Emits ChatEvents through `args.emit` and the terminal
 * ChatConfirmResult through `args.onResult` exactly once.
 */
export async function resumeAfterConfirm(
  ctx: ExecutionContext,
  args: ResumeAfterConfirmArgs,
): Promise<void> {
  const { chat, store, pending, emit, onResult } = args;
  const payload = pending.resumePayload;
  const attemptId = pending.attemptId ?? '';
  const kind = toolKind(pending.capabilityName);

  // 0. Resume payload sanity (chat.resume_payload_invalid). No execution yet.
  if (!payload || payload.version !== 1) {
    await terminalizeConfirmingRow(ctx, {
      actionId: pending.id,
      attemptId,
      terminalStatus: 'failed',
      completedAt: nowIso(ctx),
    });
    onResult({
      decisionRecorded: true,
      pendingStatus: 'indeterminate',
      execution: { status: 'not_requested' },
      resume: { status: 'failed' },
    });
    emit({
      type: 'turn.failed',
      code: 'chat.resume_payload_invalid',
      message: 'Resume payload malformed or unsupported version',
    });
    return;
  }

  const toolCallId = payload.toolCallId;
  const toolName = payload.toolName;
  const logicalTurnId = payload.logicalTurnId;

  // 1. Acquire the session mutation lease (needed for every store write below).
  const acq = await store.acquireSessionMutation({
    sessionId: pending.sessionId,
    ownerToken: attemptId,
    leaseMs: RESUME_LEASE_MS,
  });
  if (!acq.acquired) {
    await terminalizeConfirmingRow(ctx, {
      actionId: pending.id,
      attemptId,
      terminalStatus: 'failed',
      completedAt: nowIso(ctx),
    });
    onResult({
      decisionRecorded: true,
      pendingStatus: 'indeterminate',
      execution: { status: 'not_requested' },
      resume: { status: 'not_requested' },
    });
    emit({ type: 'turn.failed', code: 'chat.session_busy', message: 'Session busy' });
    return;
  }
  const lease = acq.lease;
  const expectedRevision = lease.sessionRevision;
  let leaseLost = false;
  const renewLease = async () => {
    if (leaseLost) return;
    try {
      const res = await store.renewSessionMutation({
        sessionId: pending.sessionId,
        leaseToken: lease.leaseToken,
        leaseMs: RESUME_LEASE_MS,
      });
      if (!res.renewed) {
        leaseLost = true;
        ctx.logger?.warn?.(
          'chat confirm-resume lost its session lease; a concurrent turn may reap this action',
          { sessionId: pending.sessionId, actionId: pending.id },
        );
      }
    } catch (err) {
      ctx.logger?.warn?.('chat confirm-resume lease renewal failed', {
        sessionId: pending.sessionId,
        actionId: pending.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  void renewLease();
  const leaseRenewTimer = setInterval(() => {
    void renewLease();
  }, LEASE_RENEW_INTERVAL_MS);

  try {
    // 2. Stamp execution start immediately before invoking the pipeline.
    await store.markExecutionStarted({
      actionId: pending.id,
      attemptId,
      executionStartedAt: nowIso(ctx),
    });

    // 3. Resolve + execute via core (D4). Access policy is enforced by executeCapability.
    const cap = ctx.__runtime?.resolveCapability?.(pending.capabilityName);
    if (!cap) {
      await store.completePending({
        actionId: pending.id,
        attemptId,
        lease,
        expectedRevision,
        terminalStatus: 'failed',
        completedAt: nowIso(ctx),
      });
      emit({
        type: 'tool.failed',
        toolCallId,
        name: toolName,
        kind,
        code: 'chat.tool_unknown_capability',
        message: 'Configured capability could not be resolved',
      });
      emit({
        type: 'confirmation.resolved',
        actionId: pending.id,
        decision: 'confirm',
        pendingStatus: 'failed',
        executionStatus: 'failed',
      });
      onResult({
        decisionRecorded: true,
        pendingStatus: 'failed',
        execution: { status: 'failed' },
        resume: { status: 'not_requested' },
      });
      emit({ type: 'turn.failed', code: 'chat.tool_failed', message: 'Confirmed action failed' });
      return;
    }

    // pending.input is the normalized value stored at propose time (C3).
    const result = await executeCapability(cap, execCtxWithSignal(ctx, args.signal), pending.input);

    if (!result.success) {
      const failCode = (result.error as { code?: string })?.code ?? 'chat.tool_failed';
      await store.completePending({
        actionId: pending.id,
        attemptId,
        lease,
        expectedRevision,
        terminalStatus: 'failed',
        completedAt: nowIso(ctx),
      });
      emit({
        type: 'tool.failed',
        toolCallId,
        name: toolName,
        kind,
        code: failCode,
        message: (result.error as { message?: string })?.message ?? 'Tool failed',
      });
      emit({
        type: 'confirmation.resolved',
        actionId: pending.id,
        decision: 'confirm',
        pendingStatus: 'failed',
        executionStatus: 'failed',
      });
      onResult({
        decisionRecorded: true,
        pendingStatus: 'failed',
        execution: { status: 'failed' },
        resume: { status: 'not_requested' },
      });
      emit({ type: 'turn.failed', code: 'chat.tool_failed', message: 'Confirmed action failed' });
      return;
    }

    // ── Execution SUCCEEDED. From here executed:true / execution.succeeded is fixed. ──
    // Any failure below is resume-fail-after-invoke: keep executed true, NO rollback.
    try {
      // 4. Append the tool observation; record the confirmed tool execution.
      const observation = safeObservation({ ok: true, result: result.data });
      const messages: ChatMessage[] = [
        ...payload.messages,
        { role: 'tool', content: observation, toolCallId, name: toolName },
      ];
      const toolsExecuted: ToolExecutionRecord[] = [
        ...payload.toolsExecuted,
        {
          toolCallId,
          name: toolName,
          kind,
          mode: 'confirm',
          status: 'completed',
          executionId: pending.id,
        },
      ];
      // 5. Restore cumulative counters — copy, NEVER reset. resumeToolLoop mutates in place.
      const counters = { ...payload.counters };
      const sourceRefs: ChatSourceRef[] = [...payload.sourceRefs];

      emit({ type: 'tool.completed', toolCallId, name: toolName, kind });

      // 6. Continue the tool phase, then the answer phase (Stage 4 driver).
      const outcome = await resumeToolLoop(ctx, {
        chat,
        messages,
        counters,
        sourceRefs,
        toolsExecuted,
        logicalTurnId,
        emit,
        signal: args.signal,
      });

      if (outcome.kind === 'paused') {
        // Nested confirm: finalize original + append continuation turn + insert new pending.
        await store.commitResumeProposal({
          lease,
          expectedRevision,
          finalizeActionId: pending.id,
          attemptId,
          completedAt: nowIso(ctx),
          continuationTurn: outcome.assistantTurn,
          newPending: outcome.newPending,
        });
        await ctx.events.emit(chatActionConfirmedEvent.name, {
          actionId: pending.id,
          capabilityName: pending.capabilityName,
        });
        emit({
          type: 'confirmation.resolved',
          actionId: pending.id,
          decision: 'confirm',
          pendingStatus: 'confirmed',
          executionStatus: 'succeeded',
        });
        emit({
          type: 'confirmation_required',
          actionId: outcome.confirmation.actionId,
          capabilityName: outcome.confirmation.capabilityName,
          confirmationMessage: outcome.confirmation.confirmationMessage,
          expiresAt: outcome.confirmation.expiresAt,
          inputSchemaHash: outcome.confirmation.inputSchemaHash,
          projection: outcome.confirmation.projection,
        });
        onResult({
          decisionRecorded: true,
          pendingStatus: 'confirmed',
          execution: { status: 'succeeded' },
          resume: { status: 'completed' },
        });
        return;
      }

      // Answer: append the continuation assistant turn and finalize.
      const resumeTurn: ChatTurnWrite = {
        role: 'assistant',
        content: outcome.answer,
        inScope: outcome.inScope,
        refusalReason: outcome.refusalReason ?? null,
        sources: outcome.sourceRefs,
        logicalTurnId,
        continuationOfTurnId: payload.proposalAssistantTurnId,
        tokensIn: outcome.usage.tokensIn,
        tokensOut: outcome.usage.tokensOut,
        costUsd: outcome.cost,
        model: outcome.model,
        latencyMs: 0,
        toolsExecuted: outcome.toolsExecuted,
      };
      try {
        await store.completePending({
          actionId: pending.id,
          attemptId,
          lease,
          expectedRevision,
          terminalStatus: 'confirmed',
          completedAt: nowIso(ctx),
          resumeTurn,
        });
      } catch {
        await reconcileConfirmedAfterCasLoss(ctx, store, {
          actionId: pending.id,
          attemptId,
          lease,
          expectedRevision,
          completedAt: nowIso(ctx),
          resumeTurn,
        });
      }
      await ctx.events.emit(chatActionConfirmedEvent.name, {
        actionId: pending.id,
        capabilityName: pending.capabilityName,
      });
      await ctx.events.emit(chatTurnCompletedEvent.name, {
        chatName: chat.name,
        sessionId: pending.sessionId,
        turnId: logicalTurnId,
        costUsd: outcome.cost,
      });
      emit({ type: 'message.delta', text: outcome.answer });
      emit({
        type: 'confirmation.resolved',
        actionId: pending.id,
        decision: 'confirm',
        pendingStatus: 'confirmed',
        executionStatus: 'succeeded',
      });
      emit({
        type: 'turn.completed',
        turnId: logicalTurnId,
        usage: { tokensIn: outcome.usage.tokensIn, tokensOut: outcome.usage.tokensOut },
        cost: outcome.cost,
        inScope: outcome.inScope,
        refusalReason: outcome.refusalReason ?? null,
        sources: outcome.sourceRefs,
      });
      onResult({
        decisionRecorded: true,
        pendingStatus: 'confirmed',
        execution: { status: 'succeeded' },
        resume: { status: 'completed' },
      });
    } catch (resumeErr) {
      // Resume-fail-after-invoke: execution already succeeded. NO rollback.
      // Best-effort finalize as 'confirmed' WITHOUT a continuation turn.
      try {
        await store.completePending({
          actionId: pending.id,
          attemptId,
          lease,
          expectedRevision,
          terminalStatus: 'confirmed',
          completedAt: nowIso(ctx),
        });
      } catch {
        await reconcileConfirmedAfterCasLoss(ctx, store, {
          actionId: pending.id,
          attemptId,
          lease,
          expectedRevision,
          completedAt: nowIso(ctx),
        });
      }
      emit({
        type: 'confirmation.resolved',
        actionId: pending.id,
        decision: 'confirm',
        pendingStatus: 'confirmed',
        executionStatus: 'succeeded',
      });
      onResult({
        decisionRecorded: true,
        pendingStatus: 'confirmed',
        execution: { status: 'succeeded' },
        resume: { status: 'failed' },
      });
      emit({ type: 'turn.failed', code: 'chat.resume_failed', message: errMessage(resumeErr) });
    }
  } catch (startErr) {
    // Failure before/during markExecutionStarted (before invoke): terminalize confirming.
    await terminalizeConfirmingRow(ctx, {
      actionId: pending.id,
      attemptId,
      terminalStatus: 'failed',
      completedAt: nowIso(ctx),
    });
    onResult({
      decisionRecorded: true,
      pendingStatus: 'indeterminate',
      execution: { status: 'indeterminate' },
      resume: { status: 'not_requested' },
    });
    emit({
      type: 'confirmation.resolved',
      actionId: pending.id,
      decision: 'confirm',
      pendingStatus: 'indeterminate',
      executionStatus: 'indeterminate',
    });
    emit({ type: 'turn.failed', code: 'chat.resume_failed', message: errMessage(startErr) });
  } finally {
    clearInterval(leaseRenewTimer);
    await store
      .releaseSessionMutation({ sessionId: pending.sessionId, leaseToken: lease.leaseToken })
      .catch(() => {});
  }
}
