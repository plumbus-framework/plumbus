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

export interface ChatPolicy {
  audience?: { roles: string[]; default?: string; mode?: 'strict' | 'permissive' };
  scope?: { description?: string; classifier?: 'inline' | 'custom'; locales?: string[] };
  reply?: { locale?: 'auto' | string };
  privacy?: { redact?: string[] };
  provenance?: { required?: boolean; minSources?: number };
  behavioral?: { cooldowns: Cooldown[] };
  action?: { allowedCapabilities?: string[] };
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
