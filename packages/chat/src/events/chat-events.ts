import { defineEvent } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

export const chatTurnCompletedEvent = defineEvent({
  name: 'chat.turn.completed',
  domain: 'chat',
  payload: z.object({
    chatName: z.string(),
    sessionId: z.string(),
    turnId: z.string(),
    costUsd: z.number(),
  }),
});

export const chatActionConfirmedEvent = defineEvent({
  name: 'chat.action.confirmed',
  domain: 'chat',
  payload: z.object({
    actionId: z.string(),
    capabilityName: z.string(),
  }),
});

export const chatRefusalRecordedEvent = defineEvent({
  name: 'chat.refusal.recorded',
  domain: 'chat',
  payload: z.object({
    chatName: z.string(),
    sessionId: z.string(),
    refusalReason: z.string().nullable(),
  }),
});
