import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { chatActionConfirmedEvent, chatActionRejectedEvent } from '../events/chat-events.js';
import { confirmPending, rejectPending } from '../runtime/pending-actions.js';

export const chatConfirmAction = defineCapability({
  name: 'chatConfirmAction',
  kind: 'action',
  domain: 'chat',
  description: 'Confirm a pending chat action',

  input: z.object({
    actionId: z.string().uuid(),
    schemaHash: z.string(),
    capabilityName: z.string(),
    execute: z.boolean(),
  }),

  output: z.object({
    executed: z.boolean(),
    result: z.unknown().optional(),
  }),

  access: {},
  effects: {
    data: ['chat:write'],
    events: [chatActionConfirmedEvent.name, chatActionRejectedEvent.name],
    external: [],
    ai: false,
  },

  async handler(ctx, input) {
    if (!input.execute) {
      const outcome = await rejectPending(ctx, input.actionId, input.schemaHash);
      if (outcome.rejected) {
        await ctx.events.emit(chatActionRejectedEvent.name, {
          actionId: input.actionId,
          capabilityName: outcome.capabilityName ?? input.capabilityName,
        });
      }
      return { executed: false };
    }
    const result = await confirmPending(
      ctx,
      input.actionId,
      async () => ({ ok: true }),
      input.schemaHash,
    );
    await ctx.events.emit(chatActionConfirmedEvent.name, {
      actionId: input.actionId,
      capabilityName: input.capabilityName,
    });
    return { executed: true, result };
  },
});
