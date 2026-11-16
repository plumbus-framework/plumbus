import type { ExecutionContext } from '@plumbus/core';
import type { ChatSourceRef } from './context.js';
import type { ToolExecutionRecord } from './tool.js';

export type ChatRefusalReason = 'off_topic' | 'unsafe' | 'asking_for_action' | 'pii_request';

/**
 * The finished assistant reply of one turn, as `validateReply` sees it: after
 * the model call, the tool phase and the post-turn guards, and BEFORE anything
 * of it is persisted.
 */
export interface ChatFinalReply {
  /** The reply text the runtime would persist and show. */
  text: string;
  inScope: boolean;
  refusalReason: ChatRefusalReason | null;
  /** Sources the reply cites (validated against the turn's resolved sources). */
  sources: ChatSourceRef[];
  /**
   * Client actions read from the model output, already validated against the
   * chat's `clientActions.schema` and capped. Empty when the chat declares none.
   */
  clientActions: unknown[];
  /**
   * The prompt's validated structured output (server-only): the custom prompt's
   * whole output in staged/Path A turns, the agent prompt's final output in
   * `orchestration: 'agent'`, the continuation's output after a confirmation.
   */
  modelOutput: unknown;
  toolsExecuted: ToolExecutionRecord[];
}

/** What the turn knew when the reply was produced. Server-only. */
export interface ChatReplyValidationContext {
  ctx: ExecutionContext;
  chatName: string;
  sessionId: string;
  turnId: string;
  userId: string;
  tenantId?: string;
  audience: string;
  locale: string;
  userMessage: string;
  /** Server-owned prompt input of this turn, when the caller supplied one. */
  promptInput?: Record<string, unknown>;
  /** `turn`: an ordinary turn. `resume`: the answer after a confirmed tool. */
  phase: 'turn' | 'resume';
  /**
   * Where this reply stands in the turn's regenerations: `attempt` is 0 for the
   * first draft and counts up with each `regenerate`; `remaining` is how many
   * more `regenerate` verdicts the turn will still act on (`maxRegenerations`
   * minus the regenerations already made).
   */
  regeneration: { attempt: number; remaining: number };
}

/**
 * The reply the turn falls back to when a `regenerate` cannot be acted on: the
 * turn's `maxRegenerations` is spent, or the regeneration call failed (an
 * outage, a cap, the deadline). It is persisted like a `replace`.
 */
export interface ChatReplyFallback {
  text: string;
  /** Moderation code recorded with the fallback; defaults to the verdict's `code`. */
  code?: string;
  clientActions?: unknown[];
}

/**
 * - `accept`: persist the reply as is. `clientActions`, when given, replaces the
 *   actions read from the model output (they are validated and capped again).
 *   `code`, when given, is recorded as the reply's moderation code (e.g. "passed
 *   after a regeneration").
 * - `replace`: persist and show `text` instead, record `code` as the reply's
 *   moderation code. Client actions are dropped unless given here.
 * - `regenerate`: ask the model again within the same turn — same prompt, same
 *   prompt input and history, plus the draft and `feedback` as the next
 *   messages — then run `validateReply` on the new reply. `code` names why
 *   (it is the `message.replaced` code of the withdrawn draft). When the turn
 *   can regenerate no more (`maxRegenerations`, default 1) or the call fails,
 *   the turn persists `fallback` instead, as a `replace`.
 */
export type ChatReplyVerdict =
  | { decision: 'accept'; code?: string; clientActions?: unknown[] }
  | { decision: 'replace'; text: string; code: string; clientActions?: unknown[] }
  | { decision: 'regenerate'; feedback: string; code: string; fallback: ChatReplyFallback };

/**
 * App hook run on the finished reply before the assistant turn is written.
 * Throwing fails the turn closed: nothing of it is persisted and the streamed
 * text is withdrawn (`message.replaced` with `chat.reply_validation_failed`).
 */
export type ChatReplyValidator = (
  reply: ChatFinalReply,
  turn: ChatReplyValidationContext,
) => ChatReplyVerdict | Promise<ChatReplyVerdict>;
