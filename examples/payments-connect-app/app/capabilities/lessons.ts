// The app's own domain on top of payments: a tutor prices a lesson, requests
// payment (server-side amount, via payments.createCharge), and the lesson follows
// the payment through events — paid, refunded, disputed.
import { defineCapability } from '@plumbus/core';
import { z } from '@plumbus/core/zod';

interface LessonRow {
  id: string;
  tutorId: string;
  studentEmail: string;
  title: string;
  priceMinor: number;
  currency: string;
  status: 'scheduled' | 'payment_requested' | 'paid' | 'partially_refunded' | 'refunded';
  chargeId: string | null;
  refundedMinor: number;
  paidEvents: number;
  disputed: boolean;
}

interface Repo<T> {
  findById(id: string): Promise<T | null>;
  findMany(query?: Partial<T>): Promise<T[]>;
  create(data: Partial<T>): Promise<T>;
  update(id: string, data: Partial<T>): Promise<T>;
}

const lessons = (ctx: { data: unknown }) => (ctx.data as { Lesson: Repo<LessonRow> }).Lesson;
const paymentCharges = (ctx: { data: unknown }) =>
  (ctx.data as { PaymentCharge: Repo<{ id: string; metadata: Record<string, string> | null }> })
    .PaymentCharge;

const lessonView = z.object({
  id: z.string(),
  title: z.string(),
  studentEmail: z.string(),
  priceMinor: z.number().int(),
  currency: z.string(),
  status: z.string(),
  chargeId: z.string().nullable(),
  refundedMinor: z.number().int(),
  paidEvents: z.number().int(),
  disputed: z.boolean(),
});
const view = (row: LessonRow) => ({
  id: row.id,
  title: row.title,
  studentEmail: row.studentEmail,
  priceMinor: row.priceMinor,
  currency: row.currency,
  status: row.status,
  chargeId: row.chargeId ?? null,
  refundedMinor: row.refundedMinor ?? 0,
  paidEvents: row.paidEvents ?? 0,
  disputed: row.disputed ?? false,
});

export const createLesson = defineCapability({
  name: 'createLesson',
  kind: 'action',
  domain: 'lessons',
  description: 'Schedule a priced lesson for a student',
  input: z.object({
    title: z.string().min(1).max(200),
    studentEmail: z.string().email(),
    priceMinor: z.number().int().positive(),
    currency: z.enum(['usd', 'gbp']),
  }),
  output: z.object({ lesson: lessonView }),
  access: { roles: ['tutor'] },
  effects: { data: ['Lesson'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const row = await lessons(ctx).create({
      ...input,
      tutorId: ctx.auth.userId ?? '',
      tenantId: ctx.auth.tenantId,
      status: 'scheduled',
      refundedMinor: 0,
      paidEvents: 0,
      disputed: false,
    } as Partial<LessonRow>);
    return { lesson: view(row) };
  },
});

export const getLesson = defineCapability({
  name: 'getLesson',
  kind: 'query',
  domain: 'lessons',
  description: "Read one of the caller's lessons",
  input: z.object({ lessonId: z.string().uuid() }),
  output: z.object({ lesson: lessonView }),
  access: { roles: ['tutor'] },
  effects: { data: ['Lesson'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const row = await lessons(ctx).findById(input.lessonId);
    if (!row || row.tutorId !== ctx.auth.userId) throw ctx.errors.notFound('Lesson not found');
    return { lesson: view(row) };
  },
});

export const requestLessonPayment = defineCapability({
  name: 'requestLessonPayment',
  kind: 'action',
  domain: 'lessons',
  description: 'Create a payment link for a lesson at its server-side price',
  input: z.object({ lessonId: z.string().uuid() }),
  output: z.object({ chargeId: z.string(), url: z.string().nullable() }),
  access: { roles: ['tutor'] },
  effects: {
    data: ['Lesson'],
    events: [],
    external: ['payments:stripe'],
    capabilities: ['payments.createCharge'],
    ai: false,
  },
  async handler(ctx, input) {
    const lesson = await lessons(ctx).findById(input.lessonId);
    if (!lesson || lesson.tutorId !== ctx.auth.userId) throw ctx.errors.notFound('Lesson not found');
    const { charge } = (await ctx.capabilities.invoke('payments.createCharge', {
      amount: lesson.priceMinor,
      currency: lesson.currency,
      description: lesson.title,
      client: { email: lesson.studentEmail, reference: `student:${lesson.studentEmail}` },
      metadata: { lessonId: lesson.id },
      requestId: `lesson:${lesson.id}`,
    })) as { charge: { id: string; url: string | null } };
    await lessons(ctx).update(lesson.id, { status: 'payment_requested', chargeId: charge.id });
    return { chargeId: charge.id, url: charge.url };
  },
});

const chargeEvent = z
  .object({ chargeId: z.string(), amount: z.number().int() })
  .passthrough();

async function lessonForCharge(ctx: { data: unknown }, chargeId: string) {
  const charge = await paymentCharges(ctx).findById(chargeId);
  const lessonId = charge?.metadata?.lessonId;
  return lessonId ? lessons(ctx).findById(lessonId) : null;
}

export const markLessonPaid = defineCapability({
  name: 'markLessonPaid',
  kind: 'eventHandler',
  domain: 'lessons',
  description: 'Mark the lesson paid when its charge is paid',
  trigger: { event: 'payments.charge.paid' },
  input: chargeEvent,
  output: z.object({ lessonId: z.string().nullable() }),
  access: { roles: ['system'] },
  effects: { data: ['Lesson', 'PaymentCharge'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const lesson = await lessonForCharge(ctx, input.chargeId);
    if (!lesson) return { lessonId: null };
    await lessons(ctx).update(lesson.id, { status: 'paid', paidEvents: (lesson.paidEvents ?? 0) + 1 });
    return { lessonId: lesson.id };
  },
});

export const markLessonRefunded = defineCapability({
  name: 'markLessonRefunded',
  kind: 'eventHandler',
  domain: 'lessons',
  description: 'Track refunds on the lesson',
  trigger: { event: 'payments.charge.refunded' },
  input: chargeEvent.extend({ amountRefunded: z.number().int(), fullyRefunded: z.boolean() }),
  output: z.object({ lessonId: z.string().nullable() }),
  access: { roles: ['system'] },
  effects: { data: ['Lesson', 'PaymentCharge'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const lesson = await lessonForCharge(ctx, input.chargeId);
    if (!lesson) return { lessonId: null };
    await lessons(ctx).update(lesson.id, {
      refundedMinor: input.amountRefunded,
      status: input.fullyRefunded ? 'refunded' : 'partially_refunded',
    });
    return { lessonId: lesson.id };
  },
});

export const flagDisputedLesson = defineCapability({
  name: 'flagDisputedLesson',
  kind: 'eventHandler',
  domain: 'lessons',
  description: 'Flag the lesson when the student disputes the payment',
  trigger: { event: 'payments.dispute.opened' },
  input: z.object({ chargeId: z.string().nullable() }).passthrough(),
  output: z.object({ lessonId: z.string().nullable() }),
  access: { roles: ['system'] },
  effects: { data: ['Lesson', 'PaymentCharge'], events: [], external: [], ai: false },
  async handler(ctx, input) {
    const lesson = input.chargeId ? await lessonForCharge(ctx, input.chargeId) : null;
    if (!lesson) return { lessonId: null };
    await lessons(ctx).update(lesson.id, { disputed: true });
    return { lessonId: lesson.id };
  },
});
