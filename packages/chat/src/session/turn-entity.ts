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
    // Multi-row logical turn grouping (user + assistant + resume rows share it).
    logicalTurnId: field.string({ optional: true }),
    continuationOfTurnId: field.string({ optional: true }),
    // Bounded ToolExecutionRecord[] for this turn (post-validation/redaction).
    toolsExecuted: field.json({ optional: true }),
    tokensIn: field.number({ required: true }),
    tokensOut: field.number({ required: true }),
    // costUsd is fractional dollars (e.g. 0.001595). Must be decimal — field.number
    // maps to PostgreSQL integer and rejects floats.
    costUsd: field.decimal({ required: true }),
    model: field.string({ required: true }),
    latencyMs: field.number({ required: true }),
    recordedAt: field.timestamp({ required: true }),
    userId: field.string({ required: true }),
  },
  indexes: [{ columns: ['sessionId', 'ordinal'], unique: true }, ['userId', 'recordedAt']],
});
