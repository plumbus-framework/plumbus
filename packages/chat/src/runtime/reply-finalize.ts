// packages/chat/src/runtime/reply-finalize.ts
import type { ExecutionContext } from '@plumbus/core';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import type {
  ChatFinalReply,
  ChatReplyFallback,
  ChatReplyValidationContext,
  ChatReplyValidator,
  ChatReplyVerdict,
} from '../types/reply.js';

/** Default and ceiling for `clientActions.maxPerReply`. */
export const CLIENT_ACTIONS_DEFAULT_MAX = 1;

/**
 * Validate and cap client actions for a chat that declares `clientActions`.
 * Non-arrays and actions failing the schema are dropped with one notice each
 * kind; actions past `maxPerReply` are dropped with a notice. Chats without
 * `clientActions` always get `[]` (nothing is read from the model output).
 */
export function normalizeClientActions(
  chat: ChatDefinition,
  raw: unknown,
  emit: (evt: ChatEvent) => void,
): unknown[] {
  const config = chat.clientActions;
  if (!config || raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const valid: unknown[] = [];
  let invalid = 0;
  for (const item of list) {
    const parsed = config.schema.safeParse(item);
    if (parsed.success) valid.push(parsed.data);
    else invalid++;
  }
  if (invalid > 0) {
    emit({
      type: 'notice',
      code: 'chat.client_action_invalid',
      message: `${invalid} client action(s) failed the chat's schema and were dropped`,
    });
  }
  const max = config.maxPerReply ?? CLIENT_ACTIONS_DEFAULT_MAX;
  if (valid.length > max) {
    emit({
      type: 'notice',
      code: 'chat.client_actions_truncated',
      message: `Reply carried ${valid.length} client actions; kept the first ${max}`,
    });
    return valid.slice(0, max);
  }
  return valid;
}

/** Read `clientActions` from a structured model output (any prompt shape). */
export function clientActionsFromOutput(output: unknown): unknown {
  if (output === null || typeof output !== 'object') return undefined;
  return (output as { clientActions?: unknown }).clientActions;
}

/** Default `maxRegenerations`: one more model call per turn. */
export const CHAT_DEFAULT_MAX_REGENERATIONS = 1;
/** Ceiling of `maxRegenerations`; each regeneration is a full model call. */
export const CHAT_MAX_REGENERATIONS_CEILING = 3;

/** `maxRegenerations` as the runtime uses it: an integer in 0..3, default 1. */
export function resolveMaxRegenerations(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CHAT_DEFAULT_MAX_REGENERATIONS;
  return Math.min(CHAT_MAX_REGENERATIONS_CEILING, Math.max(0, Math.floor(value)));
}

/**
 * The text of a custom prompt's completion as the chat shows and stores it: the
 * chat's `answerOf(output)` when it declares one, else the base `answer` field.
 * A non-string `answerOf` result is a broken prompt contract and throws.
 */
export function answerTextOf(chat: ChatDefinition, output: unknown): string {
  if (chat.answerOf) {
    const text = chat.answerOf(output);
    if (typeof text !== 'string') {
      throw new Error(`chat "${chat.name}" answerOf returned ${typeof text}, not a string`);
    }
    return text;
  }
  if (output === null || typeof output !== 'object') return '';
  const answer = (output as { answer?: unknown }).answer;
  return typeof answer === 'string' ? answer : '';
}

/**
 * How a draft is replayed to the model on a regeneration: the prompt's
 * structured output as JSON, or the text of a plain-text reply.
 */
export function draftMessageOf(reply: ChatFinalReply): string {
  const output = reply.modelOutput;
  if (output !== null && typeof output === 'object') {
    try {
      return JSON.stringify(output);
    } catch {
      return reply.text;
    }
  }
  return reply.text;
}

/** Error a regeneration callback throws to name the notice code (e.g. `chat.budget_exceeded`). */
export class ChatRegenerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChatRegenerationError';
  }
}

export type FinalizedReply =
  | {
      ok: true;
      text: string;
      clientActions: unknown[];
      moderation?: { code: string };
      /** The reply the verdict was given on: the first draft, or the last regeneration. */
      reply: ChatFinalReply;
      /** Regeneration calls made (each one a model call). */
      regenerations: number;
      /** The text the client currently shows (the last draft streamed or `message.replaced`). */
      shownText: string;
    }
  | { ok: false };

/**
 * Run the app's `validateReply` hook on the finished reply. Without a hook the
 * reply is accepted unchanged. A throwing hook fails closed (`ok: false`): the
 * caller persists nothing of the turn.
 *
 * A `regenerate` verdict calls `regenerate(feedback, draft)` — the caller asks
 * the model again through the same governed AI path and returns the new
 * finished reply — at most `maxRegenerations` times; each new draft is checked
 * again. When a draft was shown (`shownText`), every new draft is shown with `message.replaced`
 * (the verdict's code) so the client withdraws the one before. A `regenerate`
 * past the budget, or a regeneration that throws, ends in the verdict's
 * `fallback`, recorded like a `replace`.
 */
export async function finalizeReply(args: {
  ctx: ExecutionContext;
  chat: ChatDefinition;
  reply: ChatFinalReply;
  turn: Omit<ChatReplyValidationContext, 'regeneration'>;
  validateReply?: ChatReplyValidator;
  emit: (evt: ChatEvent) => void;
  maxRegenerations?: number;
  regenerate?: (feedback: string, draft: ChatFinalReply) => Promise<ChatFinalReply>;
  /**
   * The text the client shows for this turn so far (the streamed draft, which a
   * post-turn guard may since have rewritten). Absent: nothing was shown.
   */
  shownText?: string;
}): Promise<FinalizedReply> {
  const { chat, emit } = args;
  const streamed = args.shownText !== undefined;
  let reply = args.reply;
  let shownText = args.shownText ?? reply.text;
  let regenerations = 0;
  if (!args.validateReply) {
    return {
      ok: true,
      text: reply.text,
      clientActions: reply.clientActions,
      reply,
      regenerations,
      shownText,
    };
  }
  const max = args.regenerate ? resolveMaxRegenerations(args.maxRegenerations) : 0;
  const replaced = (
    text: string,
    code: string,
    clientActions: unknown[] | undefined,
  ): FinalizedReply => ({
    ok: true,
    text,
    clientActions:
      clientActions === undefined ? [] : normalizeClientActions(chat, clientActions, emit),
    moderation: { code },
    reply,
    regenerations,
    shownText,
  });
  for (;;) {
    let verdict: ChatReplyVerdict;
    try {
      verdict = await args.validateReply(reply, {
        ...args.turn,
        regeneration: { attempt: regenerations, remaining: max - regenerations },
      });
    } catch (err) {
      args.ctx.logger?.warn?.('chat validateReply hook failed', {
        chatName: chat.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false };
    }
    if (verdict?.decision === 'replace') {
      if (typeof verdict.text !== 'string' || typeof verdict.code !== 'string' || !verdict.code) {
        args.ctx.logger?.warn?.('chat validateReply returned an invalid replace verdict', {
          chatName: chat.name,
        });
        return { ok: false };
      }
      return replaced(verdict.text, verdict.code, verdict.clientActions);
    }
    if (verdict?.decision === 'accept') {
      if (verdict.code !== undefined && (typeof verdict.code !== 'string' || !verdict.code)) {
        args.ctx.logger?.warn?.('chat validateReply returned an invalid accept code', {
          chatName: chat.name,
        });
        return { ok: false };
      }
      return {
        ok: true,
        text: reply.text,
        clientActions:
          verdict.clientActions === undefined
            ? reply.clientActions
            : normalizeClientActions(chat, verdict.clientActions, emit),
        ...(verdict.code ? { moderation: { code: verdict.code } } : {}),
        reply,
        regenerations,
        shownText,
      };
    }
    if (verdict?.decision === 'regenerate') {
      if (!validRegenerate(verdict)) {
        args.ctx.logger?.warn?.('chat validateReply returned an invalid regenerate verdict', {
          chatName: chat.name,
        });
        return { ok: false };
      }
      const fallback = verdict.fallback;
      const fallbackReply = () =>
        replaced(fallback.text, fallback.code ?? verdict.code, fallback.clientActions);
      if (!args.regenerate || regenerations >= max) return fallbackReply();
      let next: ChatFinalReply;
      try {
        next = await args.regenerate(verdict.feedback, reply);
      } catch (err) {
        args.ctx.logger?.warn?.('chat reply regeneration failed', {
          chatName: chat.name,
          error: err instanceof Error ? err.message : String(err),
        });
        emit({
          type: 'notice',
          code: err instanceof ChatRegenerationError ? err.code : 'chat.regeneration_failed',
          message: 'The reply could not be written again; the fallback is used',
        });
        // The failed call may still have been made; the caller counts it from its usage.
        return fallbackReply();
      }
      regenerations++;
      reply = next;
      if (streamed) {
        emit({ type: 'message.replaced', text: reply.text, code: verdict.code });
        shownText = reply.text;
      }
      continue;
    }
    args.ctx.logger?.warn?.('chat validateReply returned no verdict', { chatName: chat.name });
    return { ok: false };
  }
}

function validRegenerate(
  verdict: Extract<ChatReplyVerdict, { decision: 'regenerate' }>,
): verdict is Extract<ChatReplyVerdict, { decision: 'regenerate' }> & {
  fallback: ChatReplyFallback;
} {
  const fallback = verdict.fallback as ChatReplyFallback | undefined;
  return (
    typeof verdict.feedback === 'string' &&
    verdict.feedback.trim() !== '' &&
    typeof verdict.code === 'string' &&
    verdict.code !== '' &&
    fallback !== null &&
    typeof fallback === 'object' &&
    typeof fallback.text === 'string' &&
    (fallback.code === undefined || (typeof fallback.code === 'string' && fallback.code !== ''))
  );
}
