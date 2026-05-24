import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { chatTurnRepo } from '../internal/chat-repos.js';

export const chatListTurns = defineCapability({
  name: 'chatListTurns',
  kind: 'query',
  domain: 'chat',
  description: 'List turns for a chat session',

  input: z.object({
    sessionId: z.string().uuid(),
    limit: z.number().int().min(1).max(100).optional(),
  }),

  output: z.object({
    turns: z.array(z.record(z.unknown())),
  }),

  access: {},
  effects: { data: ['chat:read'], events: [], external: [], ai: false },

  async handler(ctx, input) {
    const turns = await chatTurnRepo(ctx).findMany(
      { sessionId: input.sessionId },
      { orderBy: 'ordinal', orderDir: 'asc', limit: input.limit ?? 50 },
    );
    return { turns: turns as unknown as Record<string, unknown>[] };
  },
});
