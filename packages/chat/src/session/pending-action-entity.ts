import { defineEntity, field } from '@plumbus/core';

export const chatPendingActionEntity = defineEntity({
  name: 'ChatPendingAction',
  domain: 'chat',
  tenantScoped: true,
  fields: {
    id: field.id(),
    sessionId: field.relation({ entity: 'ChatSession', type: 'many-to-one', optional: false }),
    version: field.number({ required: true, default: 2 }),
    // Session revision observed when the proposal was committed. Claim compares
    // this against the live session revision to detect chat.confirm_stale.
    expectedSessionRevision: field.number({ required: true, default: 0 }),
    capabilityName: field.string({ required: true }),
    // C3: normalized value ONLY (Zod-parsed, defaults/coercions applied). Never
    // re-read from the client at confirm time.
    input: field.json({ required: true }),
    inputSchemaHash: field.string({ required: true }),
    toolBindingHash: field.string({ required: true }),
    confirmationMessage: field.string({ required: true }),
    confirmationProjection: field.json({ optional: true }),
    // pending → confirming → { confirmed | failed | indeterminate }; plus
    // rejected / expired terminal transitions from pending.
    status: field.enum(
      ['pending', 'confirming', 'confirmed', 'rejected', 'expired', 'failed', 'indeterminate'],
      { required: true },
    ),
    attemptId: field.string({ optional: true }),
    claimedAt: field.timestamp({ optional: true }),
    executionStartedAt: field.timestamp({ optional: true }),
    completedAt: field.timestamp({ optional: true }),
    expiresAt: field.timestamp({ required: true }),
    // Serialized ChatToolResumePayloadV1 (<=256 KiB, enforced before commit).
    resumePayload: field.json({ optional: true }),
  },
  indexes: [['sessionId', 'status']],
});
