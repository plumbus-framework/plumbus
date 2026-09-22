import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { runChatTurn, type RunChatTurnOpts } from '../runtime/run-turn.js';
import type { ChatDefinition } from '../types/chat.js';
import { capClientHistory, validateClientHistorySize } from '../runtime/constants.js';

/**
 * `opts` injects storage for the turns this capability runs — pass a
 * `sessionStore` to serve the chat from a backend other than `ctx.data`.
 */
export function createChatTurnCapability(chat: ChatDefinition, opts?: RunChatTurnOpts) {
  return defineCapability({
    name: `chatTurn_${chat.name}`,
    kind: 'action',
    domain: 'chat',
    description: `Execute one turn of chat "${chat.name}"`,

    input: z.object({
      sessionId: z.string().uuid(),
      userMessage: z.string().min(1),
      audience: z.string(),
      locale: z.string(),
      clientHistory: z
        .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
        .optional(),
    }),

    output: z.object({
      events: z.array(z.record(z.unknown())),
    }),

    access: chat.access,
    effects: { data: ['chat:write'], events: [], external: [], ai: true },

    async handler(ctx, input) {
      validateClientHistorySize(input.clientHistory);
      const events: Record<string, unknown>[] = [];
      for await (const evt of runChatTurn(
        ctx,
        {
          chatDefinition: chat,
          sessionId: input.sessionId,
          userMessage: input.userMessage,
          audience: input.audience,
          locale: input.locale,
          clientHistory: capClientHistory(input.clientHistory),
        },
        opts,
      )) {
        events.push(evt as Record<string, unknown>);
      }
      return { events };
    },
  });
}
