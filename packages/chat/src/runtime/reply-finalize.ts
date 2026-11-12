// packages/chat/src/runtime/reply-finalize.ts
import type { ExecutionContext } from '@plumbus/core';
import type { ChatDefinition } from '../types/chat.js';
import type { ChatEvent } from '../types/event.js';
import type {
  ChatFinalReply,
  ChatReplyValidationContext,
  ChatReplyValidator,
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

export type FinalizedReply =
  | {
      ok: true;
      text: string;
      clientActions: unknown[];
      moderation?: { code: string };
    }
  | { ok: false };

/**
 * Run the app's `validateReply` hook on the finished reply. Without a hook the
 * reply is accepted unchanged. A throwing hook fails closed (`ok: false`): the
 * caller persists nothing of the turn.
 */
export async function finalizeReply(args: {
  ctx: ExecutionContext;
  chat: ChatDefinition;
  reply: ChatFinalReply;
  turn: ChatReplyValidationContext;
  validateReply?: ChatReplyValidator;
  emit: (evt: ChatEvent) => void;
}): Promise<FinalizedReply> {
  const { chat, reply, emit } = args;
  if (!args.validateReply) {
    return { ok: true, text: reply.text, clientActions: reply.clientActions };
  }
  let verdict: Awaited<ReturnType<ChatReplyValidator>>;
  try {
    verdict = await args.validateReply(reply, args.turn);
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
    return {
      ok: true,
      text: verdict.text,
      clientActions:
        verdict.clientActions === undefined
          ? []
          : normalizeClientActions(chat, verdict.clientActions, emit),
      moderation: { code: verdict.code },
    };
  }
  if (verdict?.decision === 'accept') {
    return {
      ok: true,
      text: reply.text,
      clientActions:
        verdict.clientActions === undefined
          ? reply.clientActions
          : normalizeClientActions(chat, verdict.clientActions, emit),
    };
  }
  args.ctx.logger?.warn?.('chat validateReply returned no verdict', { chatName: chat.name });
  return { ok: false };
}
