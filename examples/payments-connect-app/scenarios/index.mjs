// Scenarios for the payments test app, run in order against the real stack
// (Postgres, API + worker, outbox) and the Stripe simulator.
//
// Each scenario gets `t`:
//   t.as({ userId, tenantId, roles })  signed-in caller → .action(domain, name, input) / .query(...) / .call(...)
//   t.sim(method, route, body)          Stripe simulator (control API under /_sim)
//   t.sql                               postgres client on the app database
//   t.appUrl, t.waitFor(fn, opts), t.assert(cond, message), t.shared (state across scenarios)
//
// `planned` entries are later phases: they are listed in every run (so the
// roadmap lives next to the tests) and name what each will need.

const tutorA = { userId: 'tutor-ada', tenantId: 'school-north', roles: ['tutor'] };
const tutorB = { userId: 'tutor-ben', tenantId: 'school-north', roles: ['tutor'] };
const tutorC = { userId: 'tutor-cy', tenantId: 'school-south', roles: ['tutor'] };
const student = { userId: 'student-1', tenantId: 'school-north', roles: ['student'] };

async function connectAndActivate(t, who, input = {}) {
  const tutor = t.as(who);
  const started = await tutor.action('payments', 'start-merchant-onboarding', input);
  t.assert(started.onboardingUrl?.includes('/connect/onboard/'), `onboarding url: ${started.onboardingUrl}`);
  const accountId = new URL(started.onboardingUrl).pathname.split('/').pop();
  await t.sim('POST', `/_sim/accounts/${accountId}/complete-onboarding`);
  const active = await t.waitFor(async () => {
    const { merchantAccount } = await tutor.query('payments', 'get-merchant-account');
    return merchantAccount?.status === 'active' ? merchantAccount : null;
  }, { what: `${who.userId} to become active through the account webhook` });
  return { tutor, accountId, merchantAccount: active };
}

async function payLesson(t, tutor, lesson) {
  const { chargeId, url } = await tutor.action('lessons', 'request-lesson-payment', { lessonId: lesson.id });
  const sessionId = new URL(url).pathname.split('/').pop();
  await t.sim('POST', `/_sim/checkout/${sessionId}/pay`);
  const paid = await t.waitFor(async () => {
    const result = await tutor.query('lessons', 'get-lesson', { lessonId: lesson.id });
    return result.lesson.status === 'paid' ? result.lesson : null;
  }, { what: `lesson ${lesson.id} to be paid through the payment webhook` });
  return { chargeId, sessionId, lesson: paid };
}

export const scenarios = [
  {
    id: 'webhook-destinations',
    title: '`plumbus payments webhooks setup` + `doctor --live` against the simulator',
    async run(t) {
      const destinations = await t.sim('GET', '/_sim/state');
      t.assert(destinations.destinations.length === 2, `2 destinations, got ${destinations.destinations.length}`);
      t.assert(t.shared.doctor.includes('stripe_use_restricted_key'), 'doctor ran live checks');
      t.assert(!t.shared.doctor.includes('✖'), `doctor reported errors:\n${t.shared.doctor}`);
    },
  },
  {
    id: 'onboard-full',
    title: 'Tutor connects Stripe (full dashboard) and becomes active via a thin v2 account event',
    async run(t) {
      const result = await connectAndActivate(t, tutorA);
      t.assert(result.merchantAccount.dashboard === 'full', 'full dashboard');
      t.assert(result.merchantAccount.lossesCollector === 'provider', 'Stripe covers losses');
      t.shared.a = result;
    },
  },
  {
    id: 'onboard-express',
    title: 'Second tutor picks Express (platform pays fees + covers losses) and gets a login link',
    async run(t) {
      const result = await connectAndActivate(t, tutorB, { dashboard: 'express' });
      t.assert(result.merchantAccount.feesCollector === 'platform', 'platform pays fees');
      const link = await result.tutor.action('payments', 'open-merchant-dashboard');
      t.assert(link.url.includes('/express/'), `express link: ${link.url}`);
      const change = await result.tutor.call('POST', '/api/payments/start-merchant-onboarding', { dashboard: 'full' });
      t.assert(change.status === 409, `dashboard is permanent (got ${change.status})`);
      t.shared.b = result;
    },
  },
  {
    id: 'lesson-paid',
    title: 'Server-priced lesson → payment link → paid via checkout webhook → lesson marked paid (5% cut)',
    async run(t) {
      const { tutor } = t.shared.a;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Algebra 101',
        studentEmail: 'parent@example.com',
        priceMinor: 4000,
        currency: 'usd',
      });
      const paid = await payLesson(t, tutor, lesson);
      const { charge } = await tutor.query('payments', 'get-charge', { chargeId: paid.chargeId });
      t.assert(charge.status === 'paid', `charge status ${charge.status}`);
      t.assert(charge.platformFeeAmount === 200, `5% of 4000 = 200, got ${charge.platformFeeAmount}`);
      t.assert(paid.lesson.paidEvents === 1, `paidEvents ${paid.lesson.paidEvents}`);
      t.shared.paid = { ...paid, lessonId: lesson.id };
    },
  },
  {
    id: 'duplicate-webhook',
    title: 'Stripe redelivers the payment event: recorded once, lesson handler runs once',
    async run(t) {
      const [row] = await t.sql`select provider_event_id from payment_provider_event where type = 'checkout.session.completed' order by received_at limit 1`;
      await t.sim('POST', `/_sim/events/${row.provider_event_id}/redeliver`);
      await t.sim('POST', `/_sim/events/${row.provider_event_id}/redeliver`);
      const [{ count }] = await t.sql`select count(*)::int as count from payment_provider_event where provider_event_id = ${row.provider_event_id}`;
      t.assert(count === 1, `ledger rows for the event: ${count}`);
      await new Promise((r) => setTimeout(r, 1500));
      const { lesson } = await t.shared.a.tutor.query('lessons', 'get-lesson', { lessonId: t.shared.paid.lessonId });
      t.assert(lesson.paidEvents === 1, `paidEvents after redelivery: ${lesson.paidEvents}`);
    },
  },
  {
    id: 'express-fee',
    title: 'Express tutor pays more: fee function gives 8% + 30',
    async run(t) {
      const { tutor } = t.shared.b;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Physics', studentEmail: 'kid@example.com', priceMinor: 4000, currency: 'usd',
      });
      const paid = await payLesson(t, tutor, lesson);
      const { charge } = await tutor.query('payments', 'get-charge', { chargeId: paid.chargeId });
      t.assert(charge.platformFeeAmount === 350, `8% of 4000 + 30 = 350, got ${charge.platformFeeAmount}`);
    },
  },
  {
    id: 'refunds',
    title: 'Partial then full refund: refund webhooks update the charge and the lesson',
    async run(t) {
      const { tutor } = t.shared.a;
      const { chargeId, lessonId } = t.shared.paid;
      const first = await tutor.action('payments', 'refund-charge', { chargeId, amount: 1500, requestId: 'refund-1' });
      const again = await tutor.action('payments', 'refund-charge', { chargeId, amount: 1500, requestId: 'refund-1' });
      t.assert(again.created === false && again.refund.id === first.refund.id, 'requestId is idempotent');
      const [refund] = await t.sql`select provider_refund_id from payment_refund where id = ${first.refund.id}`;
      await t.sim('POST', `/_sim/refunds/${refund.provider_refund_id}/settle`, { status: 'succeeded' });
      await t.waitFor(async () => {
        const { lesson } = await tutor.query('lessons', 'get-lesson', { lessonId });
        return lesson.status === 'partially_refunded' && lesson.refundedMinor === 1500;
      }, { what: 'partial refund to reach the lesson' });
      const rest = await tutor.action('payments', 'refund-charge', { chargeId });
      t.assert(rest.refund.amount === 2500, `remaining refund 2500, got ${rest.refund.amount}`);
      const [second] = await t.sql`select provider_refund_id from payment_refund where id = ${rest.refund.id}`;
      await t.sim('POST', `/_sim/refunds/${second.provider_refund_id}/settle`, { status: 'succeeded' });
      await t.waitFor(async () => {
        const { lesson } = await tutor.query('lessons', 'get-lesson', { lessonId });
        return lesson.status === 'refunded';
      }, { what: 'full refund to reach the lesson' });
      const [{ count }] = await t.sql`select count(*)::int as count from payment_refund where charge_id = ${chargeId}`;
      t.assert(count === 2, `2 refund rows (no duplicates from racing webhooks), got ${count}`);
      const over = await tutor.call('POST', '/api/payments/refund-charge', { chargeId, amount: 1 });
      t.assert(over.status === 409 || over.status === 400, `nothing left to refund (got ${over.status})`);
    },
  },
  {
    id: 'dispute',
    title: 'Student disputes a payment: dispute webhook flags the lesson',
    async run(t) {
      const { tutor } = t.shared.a;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Chemistry', studentEmail: 'upset@example.com', priceMinor: 6000, currency: 'usd',
      });
      const paid = await payLesson(t, tutor, lesson);
      const state = await t.sim('GET', '/_sim/state');
      const session = state.sessions.find((s) => s.id === paid.sessionId);
      await t.sim('POST', `/_sim/payments/${session.payment_intent.id}/dispute`, { reason: 'product_not_received' });
      await t.waitFor(async () => {
        const result = await tutor.query('lessons', 'get-lesson', { lessonId: lesson.id });
        return result.lesson.disputed;
      }, { what: 'the dispute to flag the lesson' });
      const [dispute] = await t.sql`select status, reason from payment_dispute where charge_id = ${paid.chargeId}`;
      t.assert(dispute?.status === 'needs_response' && dispute.reason === 'product_not_received', JSON.stringify(dispute));
    },
  },
  {
    id: 'expired-link',
    title: 'Unpaid link expires: charge moves to expired',
    async run(t) {
      const { tutor } = t.shared.a;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Biology', studentEmail: 'late@example.com', priceMinor: 3000, currency: 'usd',
      });
      const { chargeId, url } = await tutor.action('lessons', 'request-lesson-payment', { lessonId: lesson.id });
      await t.sim('POST', `/_sim/checkout/${new URL(url).pathname.split('/').pop()}/expire`);
      await t.waitFor(async () => {
        const { charge } = await tutor.query('payments', 'get-charge', { chargeId });
        return charge.status === 'expired';
      }, { what: 'the charge to expire' });
    },
  },
  {
    id: 'stripe-errors',
    title: "Stripe's own validation reaches the caller (amount below Checkout minimum)",
    async run(t) {
      const result = await t.shared.a.tutor.call('POST', '/api/payments/create-charge', {
        amount: 10, currency: 'usd', description: 'Too small',
      });
      t.assert(result.status === 400, `status ${result.status}`);
      t.assert(/at least/.test(result.error?.message ?? ''), `message: ${result.error?.message}`);
      const [{ count }] = await t.sql`select count(*)::int as count from payment_charge where description = 'Too small'`;
      t.assert(count === 0, 'no local row left behind after the provider rejected the charge');
    },
  },
  {
    id: 'tenant-isolation',
    title: "A tutor in another tenant cannot see or refund someone else's charge",
    async run(t) {
      const other = t.as(tutorC);
      const { merchantAccount } = await other.query('payments', 'get-merchant-account');
      t.assert(merchantAccount === null, 'no account in the other tenant');
      const peek = await other.call('GET', '/api/payments/get-charge', { chargeId: t.shared.paid.chargeId });
      t.assert(peek.status === 404, `get-charge across tenants → ${peek.status}`);
      const sameTenant = t.shared.b.tutor;
      const peek2 = await sameTenant.call('GET', '/api/payments/get-charge', { chargeId: t.shared.paid.chargeId });
      t.assert(peek2.status === 404, `another seller in the same tenant → ${peek2.status}`);
    },
  },
  {
    id: 'access-control',
    title: 'Non-tutors are refused; internal webhook capabilities are closed to users',
    async run(t) {
      const s = t.as(student);
      const charge = await s.call('POST', '/api/payments/create-charge', { amount: 1000, currency: 'usd', description: 'x' });
      t.assert(charge.status === 403, `student create-charge → ${charge.status}`);
      const internal = await t.shared.a.tutor.call('POST', '/api/payments/apply-provider-state', {
        ledgerId: '00000000-0000-0000-0000-000000000000', observedAt: new Date().toISOString(), changes: [],
      });
      t.assert(internal.status === 403, `tutor apply-provider-state → ${internal.status}`);
    },
  },
  {
    id: 'webhook-security',
    title: 'Forged webhook signature → 400, nothing recorded',
    async run(t) {
      const [{ before }] = await t.sql`select count(*)::int as before from payment_provider_event`;
      const response = await fetch(`${t.appUrl}/payments/webhooks/stripe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=forged` },
        body: JSON.stringify({ id: 'evt_forged', object: 'event', type: 'checkout.session.completed' }),
      });
      t.assert(response.status === 400, `status ${response.status}`);
      const [{ after }] = await t.sql`select count(*)::int as after from payment_provider_event`;
      t.assert(after === before, 'ledger unchanged');
    },
  },

  // ── Later phases (documented in docs/payments/options.md as not available yet) ──
  { id: 'destination-charges', planned: true, title: 'Destination charges (charge on the platform, pay one seller)', needs: 'recipient configuration on v2 accounts (stripe_transfers); Checkout payment_intent_data.transfer_data + on_behalf_of; sim: transfers, platform-level charges and refunds with reverse_transfer' },
  { id: 'separate-charges', planned: true, title: 'Separate charges and transfers (one payment split across sellers)', needs: 'transfer_group, /v1/transfers, platform-liable losses; sim: transfers + transfer reversals' },
  { id: 'payout-timing', planned: true, title: 'Payout schedule set by the app or the seller', needs: 'Accounts v2 merchant payout settings (or v1 settings.payouts); sim: payout schedule + payout.* events' },
  { id: 'payment-links', planned: true, title: 'Reusable Payment Links', needs: '/v1/payment_links on the seller account; sim: payment_links + checkout sessions created from them' },
  { id: 'invoices', planned: true, title: 'Invoices Stripe emails to clients', needs: '/v1/invoices + invoiceitems on the seller account; invoice.paid / invoice.payment_failed events; sim: invoice lifecycle' },
  { id: 'embedded-checkout', planned: true, title: 'Checkout embedded in the app page (ui_mode embedded_page / elements)', needs: 'client secret return + publishable key; sim: session client_secret' },
  { id: 'client-subscriptions', planned: true, title: "Recurring charges on sellers' accounts", needs: 'products/prices on connected accounts, subscription entity + events; sim: subscriptions, invoices, test clocks' },
  { id: 'client-portal', planned: true, title: 'Client self-service portal', needs: '/v1/billing_portal/sessions on the seller account; sim: portal sessions' },
  { id: 'platform-billing', planned: true, title: 'The app billing its own users (SaaS subscriptions)', needs: 'separate mode on the platform account; plans, entitlements; sim: platform customers + subscriptions' },
  { id: 'usage-billing', planned: true, title: 'Usage-based billing (e.g. AI spend)', needs: 'Stripe Billing meters (v2 meter event streams); bridge from onAICostRecorded; sim: meter events' },
  { id: 'stripe-tax', planned: true, title: "Stripe Tax on sellers' charges", needs: 'automatic_tax on Checkout, seller tax registrations; sim: tax amounts on sessions' },
];
