import type { ExecutionContext } from '@plumbus/core';
import type { TurnContext } from './turn.js';
import type { ChatEvent } from './event.js';
import type { PendingAction } from './action.js';

export interface Cooldown {
  trigger: 'refusal' | 'guardFailure' | 'budget';
  count: number;
  windowSeconds?: number;
  durationSeconds: number;
  scope?: 'session' | 'user';
}

/** Path A action policy. */
export interface ChatActionPolicy {
  allowedCapabilities?: string[];
  /** C8: NEW optional Path-A field. When true, a confirmed legacy requestedAction
   *  executes through the framework capability pipeline. Default false (decision-only). */
  /**
   * RESERVED — not yet enforced. Intended to gate whether a confirmed legacy
   * `requestedAction` (Path A) executes through the framework pipeline. No runtime
   * code branches on it today; Path B tool confirmation always executes, and Path A
   * execution is driven by the confirm request's `execute` flag. Kept optional and
   * additive; wiring it is a future change.
   */
  frameworkExecuteOnConfirm?: boolean;
}

export interface ChatToolCallingPolicy {
  enabled: boolean;
  capabilities?: string[];
  autoStartFlows?: string[];

  /** Default 5; range 1..20. */
  maxToolRounds?: number;
  /** Default 32; range 1..64. */
  maxTools?: number;

  /** Default 10_000; range 0..120_000. */
  flowAwaitMs?: number;
  /** Default 250; range 50..10_000. */
  flowPollIntervalMs?: number;
  /** Default 15_000; range 0..120_000. `0` disables flow polling for the turn. */
  flowAwaitBudgetMsPerTurn?: number;
  /** Default 2; range 0..20. */
  maxFlowStartsPerTurn?: number;
  /** Default 900_000 (15 min); range 60_000..3_600_000. */
  confirmationTtlMs?: number;
}

export interface ChatPolicy {
  audience?: { roles: string[]; default?: string; mode?: 'strict' | 'permissive' };
  scope?: { description?: string; classifier?: 'inline' | 'custom'; locales?: string[] };
  reply?: { locale?: 'auto' | string };
  privacy?: { redact?: string[] };
  provenance?: { required?: boolean; minSources?: number };
  behavioral?: { cooldowns: Cooldown[] };
  action?: ChatActionPolicy;
  toolCalling?: ChatToolCallingPolicy;
  /** Custom guards that run **pre-turn**, after the pre-turn built-ins and
   * before the model call. They see `turnCtx` (incl. `userMessage`) but NOT
   * `state.modelOutput`. Use for input gating (block before spending tokens). */
  custom?: Guard[];
  /** Custom guards that run **post-turn**, after the built-ins and the model
   * call. They receive `state.modelOutput` and can inspect it, mutate it (e.g.
   * redact `modelOutput.answer`), emit a notice, or require confirmation. */
  customPostTurn?: Guard[];
}

export type GuardVerdict =
  | { decision: 'allow' }
  | { decision: 'block'; reason: string; emit?: Partial<ChatEvent> }
  | { decision: 'require_confirmation'; pendingAction: PendingAction };

export interface GuardState {
  ctx: ExecutionContext;
  chatName: string;
  policy: ChatPolicy;
  modelOutput?: Record<string, unknown>;
  resolvedSources?: Set<string>;
  /** Set by runChatTurn. `true` for normal DB-backed chats; `false` when the
   * chat opts out with `persistence.saveToDb: false`. Guards that need DB
   * state should branch on this. */
  saveToDb?: boolean;
  /** Ephemeral client history for behavioral guards when saveToDb is false. */
  clientHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
  }>;
  /** From chat.budget.actions.perSession — enforced in action-guard. */
  budgetActionsPerSession?: number;
  /** Set when a guard blocks so behavioral post-guard can record guardFailure/budget triggers. */
  lastBudgetOrGuardSignal?: 'guardFailure' | 'budget';
}

export type Guard = (turnCtx: TurnContext, state: GuardState) => Promise<GuardVerdict>;

export type GuardStage = 'input' | 'context' | 'action' | 'response';
