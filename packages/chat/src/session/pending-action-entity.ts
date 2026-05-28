import { defineEntity, field } from '@plumbus/core';

export const chatPendingActionEntity = defineEntity({
  name: 'ChatPendingAction',
  domain: 'chat',
  tenantScoped: true,
  fields: {
    id: field.id(),
    sessionId: field.relation({ entity: 'ChatSession', type: 'many-to-one', optional: false }),
    capabilityName: field.string({ required: true }),
    input: field.json({ required: true }),
    schemaHash: field.string({ required: true }),
    confirmationMessage: field.string({ required: true }),
    expiresAt: field.timestamp({ required: true }),
    status: field.enum(['pending', 'confirmed', 'rejected', 'expired'], { required: true }),
  },
  indexes: [['sessionId', 'status']],
});
