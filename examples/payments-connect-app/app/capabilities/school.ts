// The school platform's own money, on top of payments' server-side helpers:
//  • group classes the platform sells and splits between the tutors who teach
//    them (a platform charge, then one transfer per tutor once it is paid)
//  • the plan it bills schools for: tutor seats, AI tutor usage on a meter, and
//    the AI tutor feature gated by the plan
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';
import { payments } from '../payments/index.js';

interface Repo<T> {
  findById(id: string): Promise<T | null>;
  findMany(query?: Partial<T>): Promise<T[]>;
}

interface ChargeRow {
  id: string;
  flow: string;
  amount: number;
  currency: string;
  metadata: Record<string, string> | null;
}

interface MerchantRow {
  id: string;
  ownerType: string;
  ownerId: string;
}

const data = (ctx: { data: unknown }) =>
  ctx.data as { PaymentCharge: Repo<ChargeRow>; PaymentMerchantAccount: Repo<MerchantRow> };

export const chargeGroupClass = defineCapability({
  name: 'chargeGroupClass',
  kind: 'action',
  domain: 'school',
  description: 'Charge a student for a group class; its tutors are paid their share once it is paid',
  input: z.object({
    classId: z.string().min(1).max(60),
    studentEmail: z.string().email(),
    priceMinor: z.number().int().positive(),
    currency: z.enum(['usd', 'gbp']),
    tutorIds: z.array(z.string().min(1)).min(1).max(5),
  }),
  output: z.object({ chargeId: z.string(), url: z.string().nullable() }),
  access: { roles: ['school-admin'] },
  effects: { ...payments.effects.platform, ai: false },
  async handler(ctx, input) {
    const { charge } = await payments.platform.createCharge(ctx, {
      description: `Group class ${input.classId}`,
      currency: input.currency,
      amount: input.priceMinor,
      client: { email: input.studentEmail, reference: `student:${input.studentEmail}` },
      transferGroup: `class:${input.classId}`,
      metadata: { classId: input.classId, tutorIds: input.tutorIds.join(',') },
      requestId: `class:${input.classId}:${input.studentEmail}`,
    });
    return { chargeId: charge.id, url: charge.url };
  },
});

export const payGroupClassTutors = defineCapability({
  name: 'payGroupClassTutors',
  kind: 'eventHandler',
  domain: 'school',
  description: "Split a paid group class between its tutors (80% of the price; the school keeps the rest)",
  trigger: { event: 'payments.charge.paid' },
  input: z.object({ chargeId: z.string(), flow: z.string() }).passthrough(),
  output: z.object({ transfers: z.number().int() }),
  access: { roles: ['system'] },
  effects: {
    ...payments.effects.platform,
    data: [...payments.effects.platform.data, 'PaymentMerchantAccount'],
    ai: false,
  },
  async handler(ctx, input) {
    if (input.flow !== 'platform') return { transfers: 0 };
    const charge = await data(ctx).PaymentCharge.findById(input.chargeId);
    const tutorIds = charge?.metadata?.tutorIds?.split(',').filter(Boolean) ?? [];
    if (!charge || tutorIds.length === 0) return { transfers: 0 };
    const share = Math.floor((charge.amount * 0.8) / tutorIds.length);
    let made = 0;
    for (const tutorId of tutorIds) {
      const [merchant] = await data(ctx).PaymentMerchantAccount.findMany({
        ownerType: 'user',
        ownerId: tutorId,
      });
      if (!merchant) continue;
      await payments.platform.transferToSeller(ctx, {
        merchantAccountId: merchant.id,
        amount: share,
        currency: charge.currency,
        chargeId: charge.id,
        description: `Group class ${charge.metadata?.classId}`,
        // One transfer per tutor, however often the event is delivered.
        requestId: `class-share:${charge.id}:${tutorId}`,
      });
      made += 1;
    }
    return { transfers: made };
  },
});

export const recordAiTutorUsage = defineCapability({
  name: 'recordAiTutorUsage',
  kind: 'action',
  domain: 'school',
  description: "Meter the AI tutor's tokens for one session onto the school's plan",
  input: z.object({ sessionId: z.string().min(1), tokens: z.number().int().positive() }),
  output: z.object({ recorded: z.boolean() }),
  access: { roles: ['tutor', 'school-admin'] },
  effects: { ...payments.effects.billing, ai: false },
  async handler(ctx, input) {
    await payments.billing.recordUsage(ctx, {
      meter: 'aiTokens',
      value: input.tokens,
      // Retries of the same session are counted once.
      identifier: `ai-session:${input.sessionId}`,
    });
    return { recorded: true };
  },
});

export const askAiTutor = defineCapability({
  name: 'askAiTutor',
  kind: 'query',
  domain: 'school',
  description: "Ask the AI tutor (only on plans with the 'ai-tutor' feature)",
  input: z.object({ question: z.string().min(1).max(500) }),
  output: z.object({ answer: z.string() }),
  access: { roles: ['tutor', 'school-admin'] },
  effects: { data: ['PaymentBillingCustomer', 'PaymentEntitlement'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    if (!(await payments.billing.hasFeature(ctx, 'ai-tutor'))) {
      throw ctx.errors.forbidden("The school's plan does not include the AI tutor", {
        reason: 'feature_not_in_plan',
      });
    }
    return { answer: `(simulated) A good first step for "${input.question}" is to write down what you know.` };
  },
});

export const setSchoolSeats = defineCapability({
  name: 'setSchoolSeats',
  kind: 'action',
  domain: 'school',
  description: "Set the tutor seats on the school's per-seat plan",
  input: z.object({ seats: z.number().int().min(1).max(500) }),
  output: z.object({ seats: z.number().int() }),
  access: { roles: ['school-admin'] },
  effects: { ...payments.effects.billing, ai: false },
  async handler(ctx, input) {
    const subscription = await payments.billing.setSeats(ctx, { quantity: input.seats });
    return { seats: subscription.quantity ?? input.seats };
  },
});
