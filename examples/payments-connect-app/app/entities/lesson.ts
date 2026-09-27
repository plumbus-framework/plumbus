import { defineEntity, field } from '@plumbus/core';

/** A tutoring lesson a tutor charges a student for. */
export const lessonEntity = defineEntity({
  name: 'Lesson',
  domain: 'lessons',
  tenantScoped: true,
  retention: { duration: '2555d' },
  fields: {
    id: field.id(),
    tutorId: field.string({ required: true }),
    studentEmail: field.string({ required: true, classification: 'personal', maskedInLogs: true }),
    title: field.string({ required: true }),
    priceMinor: field.bigint({ required: true }),
    currency: field.string({ required: true }),
    status: field.enum(['scheduled', 'payment_requested', 'paid', 'partially_refunded', 'refunded'], {
      required: true,
    }),
    chargeId: field.string({ optional: true }),
    refundedMinor: field.bigint({ required: true, default: 0 }),
    // Counts payments.charge.paid deliveries handled — the e2e asserts exactly one.
    paidEvents: field.number({ required: true, default: 0 }),
    disputed: field.boolean({ required: true, default: false }),
  },
  indexes: [['tutorId'], ['chargeId']],
});
