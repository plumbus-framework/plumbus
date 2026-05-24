import { defineEntity, field } from '@plumbus/core';

export const chatTurnEntity = defineEntity({
  name: 'ChatTurn',
  domain: 'chat',
  tenantScoped: true,
  fields: {
    id: field.id(),
    sessionId: field.relation({ entity: 'ChatSession', type: 'many-to-one', optional: false }),
    ordinal: field.number({ required: true }),
    role: field.enum(['user', 'assistant', 'system'], { required: true }),
    content: field.string({ default: '' }),
    inScope: field.boolean({ required: true }),
    refusalReason: field.enum(['off_topic', 'unsafe', 'asking_for_action', 'pii_request'], {
      optional: true,
    }),
    sources: field.json({ required: true }),
    actionRequested: field.json({ optional: true }),
    actionConfirmed: field.boolean({ optional: true }),
    tokensIn: field.number({ required: true }),
    tokensOut: field.number({ required: true }),
    costUsd: field.number({ required: true }),
    model: field.string({ required: true }),
    latencyMs: field.number({ required: true }),
    recordedAt: field.timestamp({ required: true }),
    userId: field.string({ required: true }),
  },
  indexes: [
    ['sessionId', 'ordinal'],
    ['userId', 'recordedAt'],
  ],
});
