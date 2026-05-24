import { defineEntity, field } from '@plumbus/core';

export const chatSessionEntity = defineEntity({
  name: 'ChatSession',
  domain: 'chat',
  tenantScoped: true,
  fields: {
    id: field.id(),
    chatName: field.string({ required: true }),
    userId: field.string({ required: true }),
    tenantId: field.string({ optional: true }),
    audience: field.string({ required: true }),
    locale: field.string({ required: true }),
    startedAt: field.timestamp({ required: true }),
    lastTurnAt: field.timestamp({ required: true }),
    status: field.enum(['active', 'ended'], { required: true }),
    behavioralState: field.json({ required: true }),
    summaryText: field.string({ optional: true }),
    summaryTurnCount: field.number({ required: true, default: 0 }),
  },
  indexes: [
    ['chatName', 'userId'],
    ['userId', 'lastTurnAt'],
  ],
});
