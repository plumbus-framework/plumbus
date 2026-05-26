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
  custom?: Guard[];
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
  /** Set by runChatTurn ONLY when `saveToDb: false`. Lets guards (notably
   * behavioralPreGuard) enforce policy from the client-supplied history when
   * there's no chat_session row to read state from. Includes the optional
   * `refusalReason` per assistant message. */
  clientHistory?: Array<{
    role: 'user' | 'assistant';
    content: string;
    refusalReason?: 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request' | null;
  }>;
}

export type Guard = (turnCtx: TurnContext, state: GuardState) => Promise<GuardVerdict>;

export type GuardStage = 'input' | 'context' | 'action' | 'response';
