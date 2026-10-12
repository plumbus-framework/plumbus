// Scenarios for the payments test app, run in order against the real stack
// (Postgres, API + worker, outbox) and the Stripe simulator.
//
// Each scenario gets `t`:
//   t.as({ userId, tenantId, roles })  signed-in caller → .action(domain, name, input) / .query(...) / .call(...)
//   t.sim(method, route, body)          Stripe simulator (control API under /_sim)
//   t.sql                               postgres client on the app database
//   t.appUrl, t.waitFor(fn, opts), t.assert(cond, message), t.shared (state across scenarios)
//
// Later scenarios build on earlier ones (tutors, their accounts, paid lessons).

const tutorA = { userId: 'tutor-ada', tenantId: 'school-north', roles: ['tutor'] };
const tutorB = { userId: 'tutor-ben', tenantId: 'school-north', roles: ['tutor'] };
const tutorC = { userId: 'tutor-cy', tenantId: 'school-south', roles: ['tutor'] };
const student = { userId: 'student-1', tenantId: 'school-north', roles: ['student'] };
const admin = { userId: 'admin-north', tenantId: 'school-north', roles: ['school-admin'] };

const lastSegment = (url) => new URL(url).pathname.split('/').pop();
const simState = (t) => t.sim('GET', '/_sim/state');

async function connectAndActivate(t, who, input = {}) {
  const tutor = t.as(who);
  const started = await tutor.action('payments', 'start-merchant-onboarding', input);
  t.assert(started.onboardingUrl?.includes('/connect/onboard/'), `onboarding url: ${started.onboardingUrl}`);
  const accountId = lastSegment(started.onboardingUrl);
  await t.sim('POST', `/_sim/accounts/${accountId}/complete-onboarding`);
  const active = await t.waitFor(async () => {
    const { merchantAccount } = await tutor.query('payments', 'get-merchant-account');
    return merchantAccount?.status === 'active' ? merchantAccount : null;
  }, { what: `${who.userId} to become active through the account webhook` });
  return { tutor, accountId, merchantAccount: active };
}

async function waitForCharge(t, tutor, chargeId, status) {
  return t.waitFor(async () => {
    const { charge } = await tutor.query('payments', 'get-charge', { chargeId });
    return charge.status === status ? charge : null;
  }, { what: `charge ${chargeId} to be ${status}` });
}

async function payLesson(t, tutor, lesson) {
  const { chargeId, url } = await tutor.action('lessons', 'request-lesson-payment', { lessonId: lesson.id });
  const sessionId = lastSegment(url);
  await t.sim('POST', `/_sim/checkout/${sessionId}/pay`);
  const paid = await t.waitFor(async () => {
    const result = await tutor.query('lessons', 'get-lesson', { lessonId: lesson.id });
    return result.lesson.status === 'paid' ? result.lesson : null;
  }, { what: `lesson ${lesson.id} to be paid through the payment webhook` });
  return { chargeId, sessionId, lesson: paid };
}

/** Create a charge through the API and pay its page in the simulator. */
async function chargeAndPay(t, tutor, input, pay = {}) {
  const { charge } = await tutor.action('payments', 'create-charge', input);
  await t.sim('POST', `/_sim/checkout/${lastSegment(charge.url)}/pay`, pay);
  return charge;
}

export const scenarios = [
  {
    id: 'webhook-destinations',
    title: '`plumbus payments webhooks setup`, `catalog sync`, and `doctor --live` against the simulator',
    async run(t) {
      const { destinations } = await simState(t);
      t.assert(destinations.length === 2, `2 destinations, got ${destinations.length}`);
      const snapshot = destinations.find((d) => d.event_payload === 'snapshot');
      t.assert(
        snapshot.events_from.includes('@self') && snapshot.events_from.includes('@accounts'),
        `snapshot events from the platform and sellers: ${snapshot.events_from}`,
      );
      t.assert(t.shared.doctor.includes('stripe_use_restricted_key'), 'doctor ran live checks');
      t.assert(!t.shared.doctor.includes('✖'), `doctor reported errors:\n${t.shared.doctor}`);
    },
  },
  {
    id: 'onboard-full',
    title: 'Tutor connects Stripe (full dashboard, direct charges) and becomes active via thin v2 account events',
    async run(t) {
      const result = await connectAndActivate(t, tutorA);
      const m = result.merchantAccount;
      t.assert(m.dashboard === 'full' && m.chargeType === 'direct', `full + direct: ${m.dashboard}/${m.chargeType}`);
      t.assert(m.lossesCollector === 'provider', 'Stripe covers losses');
      t.assert(m.chargesEnabled && m.transfersEnabled, 'cards and (for group-class shares) transfers');
      const { accounts } = await simState(t);
      const account = accounts.find((a) => a.id === result.accountId);
      t.assert(account.applied_configurations.join() === 'merchant,recipient', `configurations ${account.applied_configurations}`);
      t.shared.a = result;
    },
  },
  {
    id: 'onboard-express',
    title: 'Second tutor picks Express: destination charges, a recipient-only account, and a login link',
    async run(t) {
      const result = await connectAndActivate(t, tutorB, { dashboard: 'express' });
      const m = result.merchantAccount;
      t.assert(m.feesCollector === 'platform' && m.chargeType === 'destination', `platform fees + destination: ${m.feesCollector}/${m.chargeType}`);
      t.assert(!m.chargesEnabled && m.transfersEnabled, 'paid through transfers, takes no cards itself');
      const { accounts } = await simState(t);
      const account = accounts.find((a) => a.id === result.accountId);
      t.assert(account.applied_configurations.join() === 'recipient', `configurations ${account.applied_configurations}`);
      const link = await result.tutor.action('payments', 'open-merchant-dashboard');
      t.assert(link.url.includes('/express/'), `express link: ${link.url}`);
      const change = await result.tutor.call('POST', '/api/payments/start-merchant-onboarding', { dashboard: 'full' });
      t.assert(change.status === 409, `dashboard is permanent (got ${change.status})`);
      t.shared.b = result;
    },
  },
  {
    id: 'lesson-paid',
    title: 'Server-priced lesson → payment page → paid via checkout webhook → lesson marked paid (5% cut)',
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
      t.assert(charge.status === 'paid' && charge.flow === 'direct', `charge ${charge.status}/${charge.flow}`);
      t.assert(charge.platformFeeAmount === 200, `5% of 4000 = 200, got ${charge.platformFeeAmount}`);
      t.assert(paid.lesson.paidEvents === 1, `paidEvents ${paid.lesson.paidEvents}`);
      const { sessions } = await simState(t);
      t.assert(sessions.find((s) => s.id === paid.sessionId).account === t.shared.a.accountId, 'the page lives on the tutor account');
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
    id: 'destination-charges',
    title: 'Express tutor: the charge lives on the platform and pays the tutor through transfer_data (8% + 30)',
    async run(t) {
      const { tutor, accountId } = t.shared.b;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Physics', studentEmail: 'kid@example.com', priceMinor: 4000, currency: 'usd',
      });
      const paid = await payLesson(t, tutor, lesson);
      const { charge } = await tutor.query('payments', 'get-charge', { chargeId: paid.chargeId });
      t.assert(charge.flow === 'destination', `flow ${charge.flow}`);
      t.assert(charge.platformFeeAmount === 350, `8% of 4000 + 30 = 350, got ${charge.platformFeeAmount}`);
      const { sessions, customers } = await simState(t);
      const session = sessions.find((s) => s.id === paid.sessionId);
      t.assert(session.account === null, 'the page lives on the platform');
      t.assert(session.payment_intent.transfer_data?.destination === accountId, `paid on to ${session.payment_intent.transfer_data?.destination}`);
      t.assert(customers.find((c) => c.id === session.customer)?.account === null, "the student is the platform's customer");
      t.shared.destination = paid;
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
    id: 'destination-refund',
    title: "Refunding a destination charge takes the tutor's share back (reverse_transfer) on the platform",
    async run(t) {
      const { tutor } = t.shared.b;
      const { chargeId } = t.shared.destination;
      const { refund } = await tutor.action('payments', 'refund-charge', { chargeId, amount: 1000 });
      const { refunds } = await simState(t);
      const sent = refunds.find((r) => r.metadata.plumbus_refund_id === refund.id);
      t.assert(sent.account === null && sent.reverse_transfer && sent.refund_application_fee, JSON.stringify(sent));
      await t.sim('POST', `/_sim/refunds/${sent.id}/settle`, { status: 'succeeded' });
      await t.waitFor(async () => {
        const { charge } = await tutor.query('payments', 'get-charge', { chargeId });
        return charge.amountRefunded === 1000;
      }, { what: 'the platform refund webhook to reach the charge' });
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
      const { sessions } = await simState(t);
      const session = sessions.find((s) => s.id === paid.sessionId);
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
    id: 'dispute-response',
    title: 'Tutor submits evidence; the dispute goes under review and takes no more answers',
    async run(t) {
      const { tutor } = t.shared.a;
      const { disputes } = await tutor.query('payments', 'list-disputes');
      const open = disputes.find((d) => d.status === 'needs_response');
      const { dispute } = await tutor.action('payments', 'respond-to-dispute', {
        disputeId: open.id,
        evidence: { productDescription: 'A one-hour chemistry lesson', serviceDate: '2026-09-01', refundPolicy: 'Refunds up to 24 hours before' },
        submit: true,
      });
      t.assert(dispute.status === 'under_review' && dispute.evidenceSubmitted, JSON.stringify(dispute));
      const state = await simState(t);
      const sent = state.disputes.find((d) => d.status === 'under_review');
      t.assert(sent.evidence.refund_policy_disclosure === 'Refunds up to 24 hours before', JSON.stringify(sent.evidence));
      const late = await tutor.call('POST', '/api/payments/accept-dispute', { disputeId: open.id });
      t.assert(late.status === 409, `answered disputes are closed to more answers (got ${late.status})`);
    },
  },
  {
    id: 'expired-link',
    title: 'Unpaid page expires: charge moves to expired',
    async run(t) {
      const { tutor } = t.shared.a;
      const { lesson } = await tutor.action('lessons', 'create-lesson', {
        title: 'Biology', studentEmail: 'late@example.com', priceMinor: 3000, currency: 'usd',
      });
      const { chargeId, url } = await tutor.action('lessons', 'request-lesson-payment', { lessonId: lesson.id });
      await t.sim('POST', `/_sim/checkout/${lastSegment(url)}/expire`);
      await waitForCharge(t, tutor, chargeId, 'expired');
    },
  },
  {
    id: 'line-items-and-options',
    title: 'Line items, a promotion code, and Stripe Tax: discount and tax recorded, fee on the items',
    async run(t) {
      const { tutor } = t.shared.a;
      const charge = await chargeAndPay(t, tutor, {
        currency: 'usd',
        description: 'Term pack',
        items: [
          { name: 'Lesson', unitAmount: 2500, quantity: 2 },
          { name: 'Workbook', description: 'Printed', unitAmount: 1500 },
        ],
        options: { allowPromotionCodes: true, automaticTax: true },
      }, { discount: 500 });
      t.assert(charge.amount === 6500 && charge.platformFeeAmount === 325, `amount ${charge.amount}, fee ${charge.platformFeeAmount}`);
      const paid = await waitForCharge(t, tutor, charge.id, 'paid');
      // The simulator's tax is 8% of what is left after the discount.
      t.assert(paid.amountDiscount === 500 && paid.amountTax === 480 && paid.amountTotal === 6480, JSON.stringify(paid));
    },
  },
  {
    id: 'custom-amount',
    title: 'The client chooses the amount (a tip); the paid amount becomes the charge amount',
    async run(t) {
      const { tutor } = t.shared.a;
      const charge = await chargeAndPay(t, tutor, {
        currency: 'usd',
        description: 'Tip your tutor',
        customAmount: { minimum: 500, preset: 1500, maximum: 10_000 },
      }, { amount: 4200 });
      const paid = await waitForCharge(t, tutor, charge.id, 'paid');
      t.assert(paid.amount === 4200 && paid.amountTotal === 4200, `amount ${paid.amount}/${paid.amountTotal}`);
    },
  },
  {
    id: 'embedded-checkout',
    title: 'Embedded payment page: the API returns what the front end mounts instead of a link',
    async run(t) {
      const { tutor, accountId } = t.shared.a;
      const { charge } = await tutor.action('payments', 'create-charge', {
        amount: 3000, currency: 'usd', description: 'Embedded lesson', ui: 'embedded',
      });
      t.assert(charge.url === null, `no hosted url: ${charge.url}`);
      t.assert(charge.checkout?.clientSecret?.includes('_secret_'), `client secret: ${JSON.stringify(charge.checkout)}`);
      t.assert(charge.checkout.publishableKey === 'pk_test_simulator' && charge.checkout.accountId === accountId, JSON.stringify(charge.checkout));
      const { sessions } = await simState(t);
      const session = sessions.find((s) => s.client_reference_id === charge.id);
      t.assert(session.ui_mode === 'embedded_page' && session.return_url.endsWith(`/returned/${charge.id}`), JSON.stringify(session));
      await t.sim('POST', `/_sim/checkout/${session.id}/pay`);
      await waitForCharge(t, tutor, charge.id, 'paid');
    },
  },
  {
    id: 'holds',
    title: 'Hold a deposit, capture part of it with the fee recomputed; release another hold',
    async run(t) {
      const { tutor } = t.shared.a;
      const held = await chargeAndPay(t, tutor, { amount: 20_000, currency: 'usd', description: 'Deposit', capture: 'manual' });
      const authorized = await waitForCharge(t, tutor, held.id, 'authorized');
      t.assert(authorized.amountCapturable === 20_000, `capturable ${authorized.amountCapturable}`);
      const { charge: captured } = await tutor.action('payments', 'capture-charge', { chargeId: held.id, amount: 15_000 });
      t.assert(captured.status === 'paid' && captured.amountTotal === 15_000 && captured.platformFeeAmount === 750, JSON.stringify(captured));
      const over = await tutor.call('POST', '/api/payments/capture-charge', { chargeId: held.id });
      t.assert(over.status === 409, `a captured hold cannot be captured again (got ${over.status})`);

      const second = await chargeAndPay(t, tutor, { amount: 5000, currency: 'usd', description: 'Deposit 2', capture: 'manual' });
      await waitForCharge(t, tutor, second.id, 'authorized');
      const { charge: released } = await tutor.action('payments', 'cancel-charge', { chargeId: second.id });
      t.assert(released.status === 'canceled', `released ${released.status}`);
      const { intents } = await simState(t);
      t.assert(intents.some((pi) => pi.metadata.plumbus_charge_id === second.id && pi.status === 'canceled'), 'the hold was released at Stripe');
    },
  },
  {
    id: 'saved-cards',
    title: 'Save a card, charge it later without the client, recover when the bank wants them, open the portal',
    async run(t) {
      const { tutor } = t.shared.a;
      const saved = await tutor.action('payments', 'save-client-payment-method', {
        client: { reference: 'student-9', email: 'nine@example.com' },
      });
      await t.sim('POST', `/_sim/checkout/${lastSegment(saved.url)}/pay`, { card: { brand: 'mastercard', last4: '4444' } });
      const [method] = await t.waitFor(async () => {
        const { paymentMethods } = await tutor.query('payments', 'list-client-payment-methods', { clientId: saved.clientId });
        return paymentMethods.length > 0 ? paymentMethods : null;
      }, { what: 'the saved card to arrive by webhook' });
      t.assert(method.brand === 'mastercard' && method.last4 === '4444', JSON.stringify(method));

      const noShow = { clientId: saved.clientId, amount: 4000, currency: 'usd', description: 'Missed lesson', requestId: 'no-show-1' };
      const { charge } = await tutor.action('payments', 'charge-saved-method', noShow);
      t.assert(charge.status === 'paid' && charge.collection === 'saved_method', `${charge.status}/${charge.collection}`);
      const again = await tutor.action('payments', 'charge-saved-method', noShow);
      t.assert(again.created === false && again.charge.id === charge.id, 'requestId is idempotent');

      await t.sim('POST', '/_sim/next-off-session', { outcome: 'authentication_required' });
      const { charge: needsClient } = await tutor.action('payments', 'charge-saved-method', {
        ...noShow, requestId: 'no-show-2',
      });
      t.assert(needsClient.status === 'requires_action' && needsClient.url?.includes('/pay/'), JSON.stringify(needsClient));
      await t.sim('POST', `/_sim/checkout/${lastSegment(needsClient.url)}/pay`);
      await waitForCharge(t, tutor, needsClient.id, 'paid');

      const portal = await tutor.action('payments', 'create-client-portal-session', { clientId: saved.clientId });
      t.assert(portal.url.includes('/portal/'), `portal ${portal.url}`);

      const removed = await tutor.action('payments', 'remove-client-payment-method', { paymentMethodId: method.id });
      t.assert(removed.paymentMethod.status === 'removed', removed.paymentMethod.status);
      const { methods } = await simState(t);
      t.assert(methods.find((m) => m.card.last4 === '4444').customer === null, 'detached at Stripe');
    },
  },
  {
    id: 'invoices',
    title: 'Stripe emails an invoice: paid through its own page; an unpaid one is voided',
    async run(t) {
      const { tutor } = t.shared.a;
      const { charge } = await tutor.action('payments', 'create-charge', {
        amount: 12_000, currency: 'usd', description: 'Autumn term', collection: 'invoice',
        client: { email: 'term@example.com', name: 'Pat Parent' },
      });
      t.assert(charge.collection === 'invoice' && charge.url.includes('/invoice/'), JSON.stringify(charge));
      const { invoices } = await simState(t);
      const sent = invoices.find((inv) => inv.id === lastSegment(charge.url));
      t.assert(sent.sent && sent.status === 'open' && sent.application_fee_amount === 600, JSON.stringify(sent));
      await t.sim('POST', `/_sim/invoices/${sent.id}/pay`);
      await waitForCharge(t, tutor, charge.id, 'paid');

      const { charge: late } = await tutor.action('payments', 'create-charge', {
        amount: 5000, currency: 'usd', description: 'Late fee', collection: 'invoice', client: { email: 'term@example.com' },
      });
      const { charge: voided } = await tutor.action('payments', 'cancel-charge', { chargeId: late.id });
      t.assert(voided.status === 'canceled', `voided ${voided.status}`);
    },
  },
  {
    id: 'payment-links',
    title: 'A reusable payment link: every payment through it becomes its own charge',
    async run(t) {
      const { tutor } = t.shared.a;
      const { link } = await tutor.action('payments', 'create-payment-link', {
        description: 'Group revision class',
        currency: 'usd',
        items: [{ name: 'Revision class', unitAmount: 1500, adjustableQuantity: { minimum: 1, maximum: 5 } }],
      });
      const linkId = lastSegment(link.url);
      await t.sim('POST', `/_sim/links/${linkId}/pay`, { quantity: 2 });
      await t.sim('POST', `/_sim/links/${linkId}/pay`, { quantity: 1 });
      const charges = await t.waitFor(async () => {
        const result = await tutor.query('payments', 'list-charges', { collection: 'link' });
        return result.charges.length === 2 && result.charges.every((c) => c.status === 'paid') ? result.charges : null;
      }, { what: 'two link payments to become charges' });
      t.assert(charges.every((c) => c.linkId === link.id), 'each charge names the link');
      t.assert(charges.map((c) => c.amount).sort().join() === '1500,3000', `amounts ${charges.map((c) => c.amount)}`);
      const { link: off } = await tutor.action('payments', 'set-payment-link-active', { linkId: link.id, active: false });
      t.assert(off.active === false, 'turned off');
      const refused = await t.sim('POST', `/_sim/links/${linkId}/pay`).catch((err) => err);
      t.assert(refused instanceof Error && /no longer active/.test(refused.message), String(refused));
    },
  },
  {
    id: 'client-subscriptions',
    title: "Tutor sells a monthly plan: checkout starts it, a failed renewal makes it past due, cancel and resume",
    async run(t) {
      const { tutor } = t.shared.a;
      const { subscription } = await tutor.action('payments', 'create-subscription', {
        client: { reference: 'student-11', email: 'eleven@example.com' },
        currency: 'usd',
        items: [{ name: 'Weekly tutoring', unitAmount: 8000, interval: 'month' }],
      });
      t.assert(subscription.status === 'incomplete' && subscription.checkoutUrl, JSON.stringify(subscription));
      await t.sim('POST', `/_sim/checkout/${lastSegment(subscription.checkoutUrl)}/pay`);
      const read = (status) => t.waitFor(async () => {
        const result = await tutor.query('payments', 'get-subscription', { subscriptionId: subscription.id });
        return result.subscription.status === status ? result : null;
      }, { what: `the subscription to be ${status}` });
      await read('active');
      const { subscriptions } = await simState(t);
      const sub = subscriptions.find((s) => s.metadata.plumbus_subscription_id === subscription.id);
      t.assert(sub.application_fee_percent === 5 && sub.account === t.shared.a.accountId, JSON.stringify(sub));
      await t.sim('POST', `/_sim/subscriptions/${sub.id}/renew`, { paid: false });
      const pastDue = await read('past_due');
      t.assert(pastDue.invoices.length === 2, `2 invoices, got ${pastDue.invoices.length}`);
      await t.sim('POST', `/_sim/subscriptions/${sub.id}/renew`, { paid: true });
      await read('active');
      const canceled = await tutor.action('payments', 'cancel-subscription', { subscriptionId: subscription.id });
      t.assert(canceled.subscription.cancelAtPeriodEnd === true, 'cancels at period end');
      const resumed = await tutor.action('payments', 'resume-subscription', { subscriptionId: subscription.id });
      t.assert(resumed.subscription.cancelAtPeriodEnd === false, 'resumed');
    },
  },
  {
    id: 'payout-timing',
    title: 'Express tutor: the app schedule, a schedule change, instant payouts, and payout webhooks',
    async run(t) {
      const { tutor, accountId } = t.shared.b;
      const { settings } = await tutor.action('payments', 'get-payout-settings', {});
      t.assert(settings.schedule.interval === 'weekly' && settings.schedule.weeklyAnchor === 'friday', `app schedule: ${JSON.stringify(settings.schedule)}`);
      const { settings: monthly } = await tutor.action('payments', 'update-payout-schedule', {
        schedule: { interval: 'monthly', monthlyAnchor: 15 },
      });
      t.assert(monthly.schedule.interval === 'monthly' && monthly.schedule.monthlyAnchor === 15, JSON.stringify(monthly.schedule));

      await t.sim('POST', `/_sim/accounts/${accountId}/balance`, { available: 10_000, instant: 5000 });
      const { payout } = await tutor.action('payments', 'create-instant-payout', { amount: 2500, currency: 'usd', requestId: 'instant-1' });
      t.assert(payout.method === 'instant' && payout.status === 'pending', JSON.stringify(payout));
      const { payouts: sent } = await simState(t);
      await t.sim('POST', `/_sim/payouts/${sent.find((p) => p.method === 'instant').id}/status`, { status: 'paid' });
      const automatic = await t.sim('POST', `/_sim/accounts/${accountId}/payout`, { amount: 900 });
      await t.sim('POST', `/_sim/payouts/${automatic.id}/status`, { status: 'failed' });
      await t.waitFor(async () => {
        const { payouts } = await tutor.query('payments', 'list-payouts');
        const statuses = payouts.map((p) => `${p.method}:${p.status}`).sort().join();
        return statuses === 'instant:paid,standard:failed';
      }, { what: 'payout webhooks to update both payouts' });

      const full = await t.shared.a.tutor.call('POST', '/api/payments/update-payout-schedule', { schedule: { interval: 'daily' } });
      t.assert(full.status === 409, `full-dashboard tutors manage their own payouts (got ${full.status})`);
    },
  },
  {
    id: 'separate-charges',
    title: 'The platform sells a group class and splits it between two tutors with transfers',
    async run(t) {
      const school = t.as(admin);
      const { chargeId, url } = await school.action('school', 'charge-group-class', {
        classId: 'robotics-1', studentEmail: 'robot@example.com', priceMinor: 10_000, currency: 'usd',
        tutorIds: [tutorA.userId, tutorB.userId],
      });
      await t.sim('POST', `/_sim/checkout/${lastSegment(url)}/pay`);
      const transfers = await t.waitFor(async () => {
        const { transfers: made } = await simState(t);
        return made.length === 2 ? made : null;
      }, { what: 'the paid-class handler to transfer both shares' });
      const destinations = transfers.map((tr) => tr.destination).sort().join();
      t.assert(destinations === [t.shared.a.accountId, t.shared.b.accountId].sort().join(), destinations);
      t.assert(transfers.every((tr) => tr.amount === 4000 && tr.transfer_group === 'class:robotics-1' && tr.source_transaction), JSON.stringify(transfers));
      const [{ flow }] = await t.sql`select flow from payment_charge where id = ${chargeId}`;
      t.assert(flow === 'platform', `flow ${flow}`);
      const { transfers: mine } = await t.shared.a.tutor.query('payments', 'list-transfers');
      t.assert(mine.length === 1 && mine[0].amount === 4000, `tutor A sees their share: ${JSON.stringify(mine)}`);
      t.shared.groupClass = { chargeId, transfers };
    },
  },
  {
    id: 'platform-billing',
    title: 'A school subscribes to a per-seat plan: entitlements arrive by webhook, seats change, the portal opens',
    async run(t) {
      const school = t.as(admin);
      const { plans } = await school.query('payments', 'list-plans');
      t.assert(plans.map((p) => p.key).join() === 'starter,school', `plans ${plans.map((p) => p.key)}`);
      const blocked = await t.shared.a.tutor.call('GET', '/api/school/ask-ai-tutor', { question: 'x' });
      t.assert(blocked.status === 403, `no plan, no AI tutor (got ${blocked.status})`);

      const { subscription } = await school.action('payments', 'subscribe-to-plan', {
        plan: 'school', price: 'monthly', quantity: 3, email: 'office@north.example',
      });
      await t.sim('POST', `/_sim/checkout/${lastSegment(subscription.checkoutUrl)}/pay`);
      await t.waitFor(async () => {
        const result = await school.query('payments', 'get-plan-subscription');
        return result.subscription?.status === 'active' && result.subscription.quantity === 3;
      }, { what: 'the plan subscription to start' });
      await t.waitFor(async () => {
        const { features } = await school.query('payments', 'get-entitlements');
        return features.includes('ai-tutor') && features.includes('lessons');
      }, { what: 'entitlements to arrive' });
      const { answer } = await t.shared.a.tutor.query('school', 'ask-ai-tutor', { question: 'fractions' });
      t.assert(answer.includes('fractions'), answer);

      const { seats } = await school.action('school', 'set-school-seats', { seats: 5 });
      t.assert(seats === 5, `seats ${seats}`);
      const { subscriptions } = await simState(t);
      const sub = subscriptions.find((s) => s.account === null && s.status === 'active');
      const planItem = sub.items.data.find((item) => item.price.lookup_key === 'plumbus:payments-connect-app:school:monthly');
      t.assert(planItem.quantity === 5, `Stripe seat quantity ${planItem.quantity}`);
      t.assert(sub.items.data.some((item) => item.price.lookup_key === 'plumbus:payments-connect-app:meter:aiTokens'), 'the AI meter is billed too');

      const portal = await school.action('payments', 'open-billing-portal');
      t.assert(portal.url.includes('/portal/'), portal.url);
      const other = await t.as(tutorC).query('payments', 'get-entitlements');
      t.assert(other.features.length === 0, 'another school has no plan');
      t.shared.planSubscription = sub;
    },
  },
  {
    id: 'usage-billing',
    title: "AI tutor usage is metered onto the school's plan, once per session",
    async run(t) {
      const { tutor } = t.shared.a;
      await tutor.action('school', 'record-ai-tutor-usage', { sessionId: 's1', tokens: 1200 });
      await tutor.action('school', 'record-ai-tutor-usage', { sessionId: 's1', tokens: 1200 });
      await tutor.action('school', 'record-ai-tutor-usage', { sessionId: 's2', tokens: 300 });
      const { meterEvents } = await simState(t);
      t.assert(meterEvents.length === 2, `2 meter events, got ${meterEvents.length}`);
      t.assert(meterEvents.every((e) => e.customer === t.shared.planSubscription.customer && e.event_name === 'ai_tokens'), JSON.stringify(meterEvents));
      t.assert(meterEvents.map((e) => e.value).join() === '1200,300', `values ${meterEvents.map((e) => e.value)}`);
    },
  },
  {
    id: 'plan-change',
    title: 'The school moves to the cheaper plan: the AI tutor goes away; cancel at period end',
    async run(t) {
      const school = t.as(admin);
      const { subscription } = await school.action('payments', 'change-plan', { plan: 'starter', price: 'monthly' });
      t.assert(subscription.plan === 'starter', `plan ${subscription.plan}`);
      await t.waitFor(async () => {
        const { features } = await school.query('payments', 'get-entitlements');
        return features.join() === 'lessons';
      }, { what: 'the AI tutor entitlement to go away' });
      const blocked = await t.shared.a.tutor.call('GET', '/api/school/ask-ai-tutor', { question: 'x' });
      t.assert(blocked.status === 403, `starter plan has no AI tutor (got ${blocked.status})`);
      const { subscription: ending } = await school.action('payments', 'cancel-plan-subscription', {});
      t.assert(ending.cancelAtPeriodEnd === true, 'cancels at period end');
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
    title: 'Non-tutors are refused; plan changes are for school admins; internal capabilities are closed',
    async run(t) {
      const s = t.as(student);
      const charge = await s.call('POST', '/api/payments/create-charge', { amount: 1000, currency: 'usd', description: 'x' });
      t.assert(charge.status === 403, `student create-charge → ${charge.status}`);
      const plan = await t.shared.a.tutor.call('POST', '/api/payments/change-plan', { plan: 'school', price: 'monthly' });
      t.assert(plan.status === 403, `tutor change-plan → ${plan.status}`);
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
];
