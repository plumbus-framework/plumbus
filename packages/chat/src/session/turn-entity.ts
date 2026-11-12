import { defineEntity, field } from '@plumbus/core/sdk';

const chatTurnFields = {
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
};

const chatTurnIndexes = () => [
  { columns: ['sessionId', 'ordinal'], unique: true },
  ['userId', 'recordedAt'],
];

export const chatTurnEntity = defineEntity({
  name: 'ChatTurn',
  domain: 'chat',
  tenantScoped: true,
  fields: chatTurnFields,
  indexes: chatTurnIndexes(),
});

/**
 * Opt-in `ChatTurn` with two more optional JSON columns: `clientActions` (the
 * validated client actions of an assistant reply) and `moderation` (the code
 * `validateReply` recorded when it replaced a reply). Register it INSTEAD of
 * `chatTurnEntity` and run `plumbus migrate generate && plumbus migrate apply`
 * to persist them through the DB-backed store. With `chatTurnEntity` the
 * columns do not exist and the DB-backed store does not keep these two fields;
 * custom session stores receive them on `appendTurn` either way.
 */
export const chatTurnWithReplyMetadataEntity = defineEntity({
  name: 'ChatTurn',
  domain: 'chat',
  tenantScoped: true,
  fields: {
    ...chatTurnFields,
    clientActions: field.json({ optional: true }),
    moderation: field.json({ optional: true }),
  },
  indexes: chatTurnIndexes(),
});
