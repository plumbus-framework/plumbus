import type { ExecutionContext } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { deepFreeze } from '../internal/deep-freeze.js';
import { throwDefineValidationError } from '../internal/validation-error.js';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import type { ChatRefusalReason } from '../types/reply.js';

/**
 * Assertions on the events of one turn.
 *
 * The first four keep their original (lenient) semantics for compatibility:
 * `expectInScope` checks only that the turn completed, `expectRefusalReason`
 * and `expectGuardFired` always pass. The others are exact.
 */
export type ChatAssertion =
  | { type: 'expectInScope'; value: boolean }
  | { type: 'expectRefusalReason'; value: string }
  | { type: 'expectNoticeEmitted'; code: string }
  | { type: 'expectGuardFired'; name: string }
  /** The turn reached `turn.completed`. */
  | { type: 'expectTurnCompleted' }
  /** The turn ended with `turn.failed` (with this `code` when given). */
  | { type: 'expectTurnFailed'; code?: string }
  /** `turn.completed.inScope` equals `value`. */
  | { type: 'expectCompletedInScope'; value: boolean }
  /** `turn.completed.refusalReason` equals `value` (`null` = no refusal). */
  | { type: 'expectCompletedRefusalReason'; value: ChatRefusalReason | null }
  /** A `message.replaced` event was emitted (with this `code` when given). */
  | { type: 'expectReplyReplaced'; code?: string }
  /** `turn.completed.clientActions` has exactly `count` entries. */
  | { type: 'expectClientActions'; count: number };

/** One turn of an evaluated conversation, as the runner recorded it. */
export interface ChatEvalTurnRecord {
  /** 0-based position in the conversation. */
  index: number;
  userMessage: string;
  /** The assistant text as the client ends up showing it (`message.replaced` applied). */
  reply: string;
  events: ChatEvent[];
  completed: boolean;
  failureCode?: string;
  inScope?: boolean;
  refusalReason?: ChatRefusalReason | null;
  clientActions: unknown[];
  moderationCode?: string;
}

export interface ChatEvalJudgeVerdict {
  pass: boolean;
  reason?: string;
}

/** Judges one turn (deterministic code, or a model judge such as `promptJudge`). */
export type ChatTurnJudge = (args: {
  ctx: ExecutionContext;
  turn: ChatEvalTurnRecord;
  transcript: ChatEvalTurnRecord[];
}) => ChatEvalJudgeVerdict | Promise<ChatEvalJudgeVerdict>;

/** Judges the whole conversation once it ended. */
export type ChatConversationJudge = (args: {
  ctx: ExecutionContext;
  transcript: ChatEvalTurnRecord[];
}) => ChatEvalJudgeVerdict | Promise<ChatEvalJudgeVerdict>;

/**
 * Produces the next user message from the conversation so far — typically an
 * app-provided model persona (`promptUserSimulator`). Return `null` or an empty
 * string to end the conversation early.
 */
export type ChatUserSimulator = (args: {
  ctx: ExecutionContext;
  transcript: ChatEvalTurnRecord[];
  turnIndex: number;
}) => string | null | Promise<string | null>;

export interface ChatScriptedTurn {
  send: string;
  then?: ChatAssertion[];
  judge?: ChatTurnJudge;
}

export interface ChatSimulatedUser {
  user: ChatUserSimulator;
  /** Maximum number of user turns (1..50). */
  maxTurns: number;
  /** Fixed first message; without it the simulator writes the first turn too. */
  opening?: string;
}

export interface ChatEvaluationScenario {
  name: string;
  given: Record<string, unknown>;
  /**
   * - `{ send }`: one turn.
   * - `{ turns }`: a scripted multi-turn conversation.
   * - `{ simulate }`: a simulated user writes each next turn, up to `maxTurns`.
   */
  when: { send: string } | { turns: ChatScriptedTurn[] } | { simulate: ChatSimulatedUser };
  /** Assertions on the scenario's single turn, or on the LAST turn of a conversation. */
  then: ChatAssertion[];
  /** Applied to every turn of the conversation. */
  perTurn?: { then?: ChatAssertion[]; judge?: ChatTurnJudge };
  /** Judges the whole conversation after its last turn. */
  judge?: ChatConversationJudge;
}

export interface ChatEvaluationDefinition {
  kind: 'chatEvaluation';
  name: string;
  chat: ChatDefinition;
  scenarios: ChatEvaluationScenario[];
}

const fn = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === 'function', {
  message: 'must be a function',
});
const assertions = z.array(z.record(z.string(), z.unknown()));

const schema = z.object({
  name: z.string().min(1),
  chat: z.custom<ChatDefinition>(),
  scenarios: z.array(
    z.object({
      name: z.string(),
      given: z.record(z.string(), z.unknown()),
      when: z.union([
        z.object({ send: z.string() }),
        z.object({
          turns: z
            .array(
              z.object({
                send: z.string(),
                then: assertions.optional(),
                judge: fn.optional(),
              }),
            )
            .min(1),
        }),
        z.object({
          simulate: z.object({
            user: fn,
            maxTurns: z.number().int().min(1).max(50),
            opening: z.string().optional(),
          }),
        }),
      ]),
      then: assertions,
      perTurn: z.object({ then: assertions.optional(), judge: fn.optional() }).optional(),
      judge: fn.optional(),
    }),
  ),
});

export function defineChatEvaluation(config: {
  name: string;
  chat: ChatDefinition;
  scenarios: ChatEvaluationScenario[];
}): ChatEvaluationDefinition {
  const parsed = schema.safeParse(config);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join('; ');
    throwDefineValidationError(`defineChatEvaluation: ${detail}`);
  }
  return deepFreeze({ ...config, kind: 'chatEvaluation' as const });
}
