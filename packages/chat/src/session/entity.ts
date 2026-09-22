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
    // Authoritative optimistic-concurrency counter. Bumped once per committed
    // single-request turn and once per committed proposal/resume. CAS target.
    revision: field.number({ required: true, default: 0 }),
    // Advisory session-mutation lease (fast-path chat.session_busy). Nullable.
    leaseToken: field.string({ optional: true }),
    leaseExpiresAt: field.timestamp({ optional: true }),
  },
  indexes: [
    ['chatName', 'userId'],
    ['userId', 'lastTurnAt'],
  ],
});
