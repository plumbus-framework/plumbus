// Local Stripe simulator for the payments test app.
//
// A stateful stand-in for the parts of Stripe's API that @plumbus/payments-stripe
// calls, on API version 2026-08-26.dahlia:
//   v2: accounts (merchant + recipient configurations), account_links, event_destinations
//   v1: account_sessions, login_links, customers, checkout/sessions (payment,
//       subscription, setup; hosted and embedded), payment_intents (off-session,
//       capture, cancel), refunds, disputes, payment_methods, billing_portal,
//       products, prices, entitlements, billing meters + meter events,
//       subscriptions, invoices + invoiceitems + invoice_payments, payment_links,
//       transfers + reversals, payouts, balance, balance_settings
// Objects live on a seller's account (Stripe-Account header) or on the platform
// (no header), like Stripe. It enforces Stripe's rules that matter here
// (Express needs platform fees + losses, direct charges need card_payments,
// destination charges need the seller's transfers capability, Checkout minimum
// amount and expiry window, refund and capture limits, lookup-key uniqueness,
// weekday-only weekly payouts), honours Idempotency-Key, and delivers signed
// webhooks — snapshot events from the platform (@self) and sellers' accounts
// (@accounts), and thin v2 account events — to the event destinations created
// through the API (`plumbus payments webhooks setup`).
//
// Control endpoints under /_sim move objects through their lifecycle (finish
// onboarding, pay — by card, or by bank debit that settles later through
// /_sim/payments/:pi/settle — renew, refund, dispute, pay out, redeliver). Browser pages
// under /connect, /pay, /buy, /invoice, /portal, and /express let a human click
// through the same steps.
//
// Unknown endpoints answer 404 with a Stripe-shaped error, so a later phase
// that starts calling a new Stripe API fails loudly until the simulator learns it.

import { createHmac, randomBytes } from 'node:crypto';

export const API_VERSION = '2026-08-26.dahlia';

/** Deterministic signing secrets so the app can be started before destinations exist. */
export const SIM_SECRETS = {
  snapshot: 'whsec_sim_snapshot_0000000000000000',
  thin: 'whsec_sim_thin_00000000000000000000',
};

const MIN_AMOUNT = { usd: 50, gbp: 30, eur: 50 };
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
const DAY = 86_400;

class StripeFailure extends Error {
  constructor(status, type, message, extra = {}) {
    super(message);
    this.status = status;
    this.body = { error: { type, message, ...extra } };
  }
}

const invalid = (message, extra) => new StripeFailure(400, 'invalid_request_error', message, extra);
const missing = (what, id) =>
  new StripeFailure(404, 'invalid_request_error', `No such ${what}: '${id}'`, { code: 'resource_missing' });

/** Stripe's form encoding (`a[b][0]=x`) → nested object. */
export function parseForm(body) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(body)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let node = out;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) {
        node[key] = value;
      } else {
        node[key] ??= /^\d+$/.test(keys[i + 1] ?? '') ? [] : {};
        node = node[key];
      }
    });
  }
  return out;
}

/** Query strings use the same encoding (`expand[0]=a`, `payment[type]=x`). */
function parseQuery(url) {
  const at = url.indexOf('?');
  return at < 0 ? {} : parseForm(url.slice(at + 1));
}

const asArray = (value) =>
  value == null ? [] : Array.isArray(value) ? value : typeof value === 'object' ? Object.values(value) : [value];
const truthy = (value) => value === true || value === 'true';
const int = (value, fallback = 0) => (value === undefined || value === '' ? fallback : Number(value));

export function sign(secret, body, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function createStripeSimulator({ Fastify, baseUrl, log = () => {} }) {
  const state = {
    accounts: new Map(),
    customers: new Map(),
    sessions: new Map(),
    intents: new Map(),
    methods: new Map(),
    refunds: new Map(),
    disputes: new Map(),
    products: new Map(),
    prices: new Map(),
    features: new Map(),
    productFeatures: new Map(),
    meters: new Map(),
    meterEvents: [],
    subscriptions: new Map(),
    invoices: new Map(),
    links: new Map(),
    transfers: new Map(),
    payouts: new Map(),
    balanceSettings: new Map(),
    balances: new Map(),
    portalConfigurations: new Map(),
    portalSessions: [],
    destinations: new Map(),
    events: new Map(),
    deliveries: [],
    idempotency: new Map(),
    // The next off-session payment's outcome (one-shot), set through /_sim/next-off-session.
    nextOffSession: null,
  };
  let counter = 0;
  // A tag per run keeps ids unique across restarts, as Stripe's are: an app
  // database that outlives the simulator never sees an id twice.
  const run = randomBytes(2).toString('hex');
  const id = (prefix) => `${prefix}_sim_${run}${(++counter).toString().padStart(6, '0')}`;
  const now = () => Math.floor(Date.now() / 1000);

  const app = Fastify({ logger: false });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
    done(null, parseForm(body)),
  );
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof StripeFailure) return reply.status(err.status).send(err.body);
    log(`simulator error: ${err.stack ?? err.message}`);
    return reply.status(500).send({ error: { type: 'api_error', message: String(err.message) } });
  });

  // Every Stripe API call needs a Bearer key; the simulator accepts any test key.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/') && !request.url.startsWith('/v2/')) return;
    const auth = request.headers.authorization ?? '';
    if (!/^Bearer (sk|rk)_test_/.test(auth)) {
      return reply.status(401).send({
        error: { type: 'invalid_request_error', message: 'Invalid API Key provided (simulator accepts test keys only)' },
      });
    }
  });

  // Idempotency: same key + same body → same response; different body → 400.
  const idempotent = (handler) => async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (!key) return handler(request, reply);
    const scope = `${request.headers['stripe-account'] ?? 'platform'}:${request.method} ${request.routeOptions.url}:${request.url}:${key}`;
    const fingerprint = JSON.stringify(request.body ?? {});
    const hit = state.idempotency.get(scope);
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        throw invalid('Keys for idempotent requests can only be used with the same parameters they were first used with.', { type: 'idempotency_error' });
      }
      return reply.status(hit.status).send(hit.response);
    }
    try {
      const response = await handler(request, reply);
      state.idempotency.set(scope, { fingerprint, response, status: reply.statusCode });
      return response;
    } catch (err) {
      // Stripe replays declines (402) for the same key too.
      if (err instanceof StripeFailure && err.status === 402) {
        state.idempotency.set(scope, { fingerprint, response: err.body, status: 402 });
      }
      throw err;
    }
  };

  /** The account a request acts on: a seller (Stripe-Account header) or the platform (null). */
  function accountOf(request) {
    const accountId = request.headers['stripe-account'];
    if (!accountId) return null;
    if (!state.accounts.has(accountId)) throw invalid(`The provided key does not have access to account '${accountId}' (or that account does not exist).`);
    return accountId;
  }

  /** An object that lives on `account` (null = platform); other accounts see a 404. */
  function own(map, what, objectId, account) {
    const object = map.get(objectId);
    if (!object || (object.account ?? null) !== account) throw missing(what, objectId);
    return object;
  }

  const expandOf = (request) => new Set(asArray(request.body?.expand ?? parseQuery(request.url).expand));

  // ── Webhook delivery ──

  async function deliver(event, { format, accountScoped }) {
    state.events.set(event.id, { event, format, accountScoped });
    const body = JSON.stringify(event);
    const targets = [...state.destinations.values()].filter(
      (d) =>
        d.event_payload === format &&
        d.status === 'enabled' &&
        d.enabled_events.includes(event.type) &&
        d.events_from.includes(accountScoped ? '@accounts' : '@self'),
    );
    for (const destination of targets) {
      const secret = destination.webhook_endpoint.signing_secret;
      let status = 0;
      try {
        const response = await fetch(destination.webhook_endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'stripe-signature': sign(secret, body) },
          body,
        });
        status = response.status;
      } catch (err) {
        status = -1;
        log(`delivery to ${destination.webhook_endpoint.url} failed: ${err.message}`);
      }
      state.deliveries.push({ eventId: event.id, type: event.type, destination: destination.name, status });
      log(`→ ${event.type} ${event.id} to ${destination.name}: ${status}`);
    }
    return targets.length;
  }

  const snapshotEvent = (type, accountId, object) => ({
    id: id('evt'),
    object: 'event',
    api_version: API_VERSION,
    created: now(),
    livemode: false,
    account: accountId ?? null,
    type,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  });

  const thinAccountEvent = (type, accountId) => ({
    id: id('evt'),
    object: 'v2.core.event',
    type,
    livemode: false,
    created: new Date().toISOString(),
    context: null,
    reason: null,
    related_object: { id: accountId, type: 'v2.core.account', url: `/v2/core/accounts/${accountId}` },
  });

  const emitAccount = (type, accountId) =>
    deliver(thinAccountEvent(type, accountId), { format: 'thin', accountScoped: false });
  /** A snapshot event from a seller's account, or from the platform (`accountId` null). */
  const emit = (type, accountId, object) =>
    deliver(snapshotEvent(type, accountId, object), { format: 'snapshot', accountScoped: Boolean(accountId) });
  // Events after a response, like Stripe (webhooks may beat or trail the API answer).
  const later = (fn) => queueMicrotask(() => void fn().catch((err) => log(`emit failed: ${err.message}`)));

  // ── Accounts ──

  function capabilityStatus(a, requested) {
    if (!requested) return null;
    if (a.closed || a.restricted) return 'restricted';
    return a.active ? 'active' : 'pending';
  }

  function accountView(a, include = new Set(['configuration.merchant', 'configuration.recipient', 'defaults', 'identity', 'requirements'])) {
    const details = a.restricted ? [{ code: 'requirements_past_due', resolution: 'provide_info' }] : [];
    const cards = capabilityStatus(a, a.requested.cards);
    const transfers = capabilityStatus(a, a.requested.transfers);
    const payouts = capabilityStatus(a, true);
    const applied = [...(a.requested.cards ? ['merchant'] : []), ...(a.requested.transfers ? ['recipient'] : [])];
    const view = {
      id: a.id,
      object: 'v2.core.account',
      applied_configurations: applied,
      closed: a.closed,
      created: a.created,
      livemode: false,
      dashboard: a.dashboard,
      contact_email: a.contact_email ?? null,
      display_name: a.display_name ?? null,
      metadata: a.metadata,
      configuration: {},
    };
    if (include.has('identity')) view.identity = { country: a.country.toUpperCase(), entity_type: 'individual' };
    if (include.has('defaults')) {
      view.defaults = {
        currency: a.currency,
        responsibilities: {
          fees_collector: a.fees_collector,
          losses_collector: a.losses_collector,
          requirements_collector: a.losses_collector === 'application' && a.dashboard === 'none' ? 'application' : 'stripe',
        },
      };
    }
    if (include.has('configuration.merchant') && a.requested.cards) {
      view.configuration.merchant = {
        applied: true,
        capabilities: {
          card_payments: { status: cards, status_details: details },
          stripe_balance: { payouts: { status: payouts, status_details: details } },
        },
      };
    }
    if (include.has('configuration.recipient') && a.requested.transfers) {
      view.configuration.recipient = {
        applied: true,
        capabilities: {
          stripe_balance: {
            stripe_transfers: { status: transfers, status_details: details },
            payouts: { status: payouts, status_details: details },
          },
        },
      };
    }
    if (include.has('requirements')) {
      view.requirements = {
        entries: a.active
          ? []
          : [
              {
                description: a.restricted ? 'Upload an updated ID document' : 'Provide your bank account and identity details',
                awaiting_action_from: 'user',
                minimum_deadline: { status: a.restricted ? 'past_due' : 'currently_due' },
                errors: [],
                requested_reasons: [{ code: 'routine_onboarding' }],
              },
            ],
      };
    }
    return view;
  }

  const canTakeCards = (a) => a?.requested.cards && a.active && !a.closed && !a.restricted;
  const canReceiveTransfers = (a) => a?.requested.transfers && a.active && !a.closed && !a.restricted;

  function requireCards(accountId) {
    if (!canTakeCards(state.accounts.get(accountId))) {
      throw invalid('Your destination account needs to have at least one of the following capabilities enabled: card_payments.', { code: 'account_invalid' });
    }
  }

  function requireTransfers(accountId) {
    const account = state.accounts.get(accountId);
    if (!account) throw missing('account', accountId);
    if (!canReceiveTransfers(account)) {
      throw invalid('Your destination account needs to have at least one of the following capabilities enabled: transfers, crypto_transfers, legacy_payments', { code: 'insufficient_capabilities_for_transfer' });
    }
  }

  /** transfer_data / on_behalf_of checks: only the platform charges on behalf of a seller. */
  function checkMoneyRouting(account, data, amount) {
    const fee = int(data?.application_fee_amount, 0);
    if (fee > amount) throw invalid('The application fee cannot exceed the amount.', { param: 'application_fee_amount' });
    const destination = data?.transfer_data?.destination;
    if (destination || data?.on_behalf_of) {
      if (account) throw invalid('transfer_data and on_behalf_of can only be used by the platform.');
      if (destination) requireTransfers(destination);
      if (data.on_behalf_of) requireCards(data.on_behalf_of);
    }
    if (account && fee > 0 && state.accounts.get(account) === undefined) throw missing('account', account);
    return {
      application_fee_amount: fee || null,
      transfer_data: destination ? { destination } : null,
      on_behalf_of: data?.on_behalf_of ?? null,
      transfer_group: data?.transfer_group ?? null,
    };
  }

  // ── Views ──

  const methodView = (m) => ({
    id: m.id,
    object: 'payment_method',
    type: 'card',
    customer: m.customer,
    card: { brand: m.brand, last4: m.last4, exp_month: 12, exp_year: 2030 },
    livemode: false,
  });

  const chargeView = (pi) =>
    pi.charge
      ? {
          id: pi.charge.id,
          object: 'charge',
          amount: pi.amount,
          amount_refunded: pi.charge.amount_refunded,
          created: pi.charge.created,
          payment_intent: pi.id,
          payment_method_details: { card: { capture_before: pi.capture_method === 'manual' ? pi.charge.created + 7 * DAY : null } },
        }
      : null;

  function intentView(pi, expand = new Set()) {
    return {
      id: pi.id,
      object: 'payment_intent',
      status: pi.status,
      amount: pi.amount,
      amount_received: pi.amount_received,
      amount_capturable: pi.amount_capturable,
      currency: pi.currency,
      livemode: false,
      application_fee_amount: pi.application_fee_amount,
      transfer_data: pi.transfer_data,
      on_behalf_of: pi.on_behalf_of,
      transfer_group: pi.transfer_group,
      capture_method: pi.capture_method,
      setup_future_usage: pi.setup_future_usage,
      customer: pi.customer,
      receipt_email: pi.receipt_email ?? null,
      description: pi.description ?? null,
      metadata: pi.metadata,
      last_payment_error: pi.last_payment_error,
      latest_charge: pi.charge ? (expand.has('latest_charge') ? chargeView(pi) : pi.charge.id) : null,
      payment_method: pi.payment_method
        ? expand.has('payment_method')
          ? methodView(state.methods.get(pi.payment_method))
          : pi.payment_method
        : null,
    };
  }

  /** Expansions under `prefix` (e.g. `payment_intent.` inside a session). */
  const under = (expand, prefix) =>
    new Set([...expand].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)));

  function sessionView(s, expand = new Set()) {
    const pi = s.payment_intent ? state.intents.get(s.payment_intent) : null;
    const piExpand = under(expand, 'payment_intent.');
    const open = s.status === 'open';
    const setup = s.setup_intent;
    return {
      id: s.id,
      object: 'checkout.session',
      mode: s.mode,
      ui_mode: s.ui_mode,
      status: s.status,
      payment_status: s.payment_status,
      url: open && s.ui_mode === 'hosted_page' ? `${baseUrl}/pay/${s.id}` : null,
      client_secret: open && s.ui_mode === 'embedded_page' ? `${s.id}_secret_${s.secret}` : null,
      expires_at: s.expires_at,
      amount_subtotal: s.amount_subtotal,
      amount_total: s.amount_total,
      total_details: { amount_discount: s.amount_discount, amount_tax: s.amount_tax, amount_shipping: 0 },
      currency: s.currency,
      livemode: false,
      client_reference_id: s.client_reference_id ?? null,
      metadata: s.metadata,
      customer: s.customer ?? null,
      customer_email: s.customer_email ?? null,
      customer_details: s.status === 'complete' ? { email: s.customer_email ?? 'client@example.com' } : null,
      payment_intent: pi ? (expand.has('payment_intent') || piExpand.size > 0 ? intentView(pi, piExpand) : pi.id) : null,
      payment_link: s.payment_link ?? null,
      subscription: s.subscription ?? null,
      setup_intent: setup
        ? expand.has('setup_intent.payment_method')
          ? { id: setup.id, object: 'setup_intent', payment_method: setup.payment_method ? methodView(state.methods.get(setup.payment_method)) : null }
          : setup.id
        : null,
      success_url: s.success_url ?? null,
      cancel_url: s.cancel_url ?? null,
      return_url: s.return_url ?? null,
    };
  }

  const refundView = (r) => ({
    id: r.id,
    object: 'refund',
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    reason: r.reason ?? null,
    failure_reason: r.failure_reason ?? null,
    metadata: r.metadata,
    payment_intent: r.payment_intent,
    charge: r.charge,
  });

  const disputeView = (d) => ({
    id: d.id,
    object: 'dispute',
    amount: d.amount,
    currency: d.currency,
    status: d.status,
    reason: d.reason,
    payment_intent: d.payment_intent,
    charge: d.charge,
    evidence: d.evidence,
    evidence_details: { due_by: d.due_by, submission_count: d.submission_count, has_evidence: Object.keys(d.evidence).length > 0 },
  });

  function priceView(p, expand = new Set()) {
    const product = state.products.get(p.product);
    return {
      id: p.id,
      object: 'price',
      active: p.active,
      currency: p.currency,
      lookup_key: p.lookup_key,
      unit_amount: p.unit_amount,
      unit_amount_decimal: p.unit_amount_decimal,
      custom_unit_amount: p.custom_unit_amount,
      product: expand.has('product') && product ? productView(product) : p.product,
      recurring: p.recurring,
      metadata: p.metadata,
      type: p.recurring ? 'recurring' : 'one_time',
    };
  }

  const productView = (p) => ({
    id: p.id,
    object: 'product',
    name: p.name,
    description: p.description,
    active: p.active,
    metadata: p.metadata,
  });

  function subscriptionView(sub, expand = new Set()) {
    const priceExpand = under(expand, 'items.data.price.');
    return {
      id: sub.id,
      object: 'subscription',
      status: sub.status,
      currency: sub.currency,
      livemode: false,
      customer: sub.customer,
      metadata: sub.metadata,
      cancel_at_period_end: sub.cancel_at_period_end,
      canceled_at: sub.canceled_at,
      ended_at: sub.ended_at,
      trial_end: sub.trial_end,
      latest_invoice: sub.latest_invoice,
      application_fee_percent: sub.application_fee_percent,
      transfer_data: sub.transfer_data,
      on_behalf_of: sub.on_behalf_of,
      items: {
        object: 'list',
        has_more: false,
        data: sub.items.map((item) => ({
          id: item.id,
          object: 'subscription_item',
          quantity: item.quantity,
          current_period_end: sub.current_period_end,
          price: priceView(state.prices.get(item.price), priceExpand),
        })),
      },
    };
  }

  function invoiceView(inv, expand = new Set()) {
    const total = inv.subtotal;
    return {
      id: inv.id,
      object: 'invoice',
      status: inv.status,
      currency: inv.currency,
      livemode: false,
      customer: inv.customer,
      customer_email: state.customers.get(inv.customer)?.email ?? null,
      metadata: inv.metadata,
      description: inv.description ?? null,
      collection_method: inv.collection_method,
      subtotal: inv.subtotal,
      total,
      amount_due: total,
      amount_paid: inv.status === 'paid' ? total : 0,
      amount_remaining: inv.status === 'paid' || inv.status === 'void' ? 0 : total,
      application_fee_amount: inv.application_fee_amount,
      total_discount_amounts: [],
      total_taxes: [],
      hosted_invoice_url: inv.status === 'draft' ? null : `${baseUrl}/invoice/${inv.id}`,
      invoice_pdf: inv.status === 'draft' ? null : `${baseUrl}/invoice/${inv.id}/pdf`,
      number: inv.number,
      due_date: inv.due_date,
      period_start: inv.period_start,
      period_end: inv.period_end,
      billing_reason: inv.billing_reason,
      attempt_count: inv.attempt_count,
      status_transitions: { paid_at: inv.paid_at, finalized_at: inv.finalized_at },
      parent: inv.subscription ? { type: 'subscription_details', subscription_details: { subscription: inv.subscription } } : null,
      lines: { object: 'list', has_more: false, data: inv.lines },
      payments: expand.has('payments')
        ? {
            object: 'list',
            has_more: false,
            data: inv.payment_intent
              ? [{ id: `inpay_${inv.id}`, object: 'invoice_payment', status: inv.status === 'paid' ? 'paid' : 'open', payment: { type: 'payment_intent', payment_intent: inv.payment_intent } }]
              : [],
          }
        : undefined,
    };
  }

  const transferView = (t) => ({
    id: t.id,
    object: 'transfer',
    amount: t.amount,
    amount_reversed: t.amount_reversed,
    currency: t.currency,
    livemode: false,
    destination: t.destination,
    transfer_group: t.transfer_group,
    source_transaction: t.source_transaction,
    metadata: t.metadata,
    reversed: t.amount_reversed >= t.amount,
  });

  const payoutView = (p) => ({
    id: p.id,
    object: 'payout',
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    method: p.method,
    arrival_date: p.arrival_date,
    failure_code: p.failure_code,
    livemode: false,
    metadata: p.metadata,
  });

  const linkView = (l) => ({
    id: l.id,
    object: 'payment_link',
    url: `${baseUrl}/buy/${l.id}`,
    active: l.active,
    metadata: l.metadata,
  });

  const list = (data, url) => ({ object: 'list', data, has_more: false, url });

  // ── v2 accounts ──

  app.post('/v2/core/accounts', idempotent(async (request) => {
    const body = request.body ?? {};
    const dashboard = body.dashboard ?? 'full';
    const fees = body.defaults?.responsibilities?.fees_collector ?? 'stripe';
    const losses = body.defaults?.responsibilities?.losses_collector ?? 'stripe';
    if (dashboard === 'express' && (fees !== 'application' || losses !== 'application')) {
      throw invalid('If `dashboard` is `express`, `fees_collector` must be `application` and `losses_collector` must be `application`.', { code: 'account_controller_express_dash_without_application_losses_or_fees' });
    }
    if (losses === 'application' && fees !== 'application') {
      throw invalid('If `losses_collector` is `application`, `fees_collector` must also be `application`.', { code: 'account_controller_stripe_pricing_platform_liable' });
    }
    if (!body.identity?.country) {
      throw invalid('The `identity.country` value is required but not provided.', { code: 'identity_country_required' });
    }
    const requested = {
      cards: truthy(body.configuration?.merchant?.capabilities?.card_payments?.requested),
      transfers: truthy(body.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.requested),
    };
    if (!requested.cards && !requested.transfers) {
      throw invalid('Request at least one capability (configuration.merchant or configuration.recipient).');
    }
    const account = {
      id: id('acct'),
      created: new Date().toISOString(),
      dashboard,
      fees_collector: fees,
      losses_collector: losses,
      country: body.identity.country,
      currency: body.defaults?.currency ?? (body.identity.country.toLowerCase() === 'gb' ? 'gbp' : 'usd'),
      contact_email: body.contact_email,
      display_name: body.display_name,
      metadata: body.metadata ?? {},
      requested,
      active: false,
      restricted: false,
      closed: false,
    };
    state.accounts.set(account.id, account);
    later(() => emitAccount('v2.core.account.created', account.id));
    return accountView(account, new Set(asArray(body.include)));
  }));

  app.get('/v2/core/accounts/:id', async (request) => {
    const account = state.accounts.get(request.params.id);
    if (!account) throw missing('account', request.params.id);
    return accountView(account, new Set(asArray(parseQuery(request.url).include)));
  });

  app.get('/v2/core/accounts', async () => ({
    data: [...state.accounts.values()].map((a) => accountView(a)),
    next_page_url: null,
    previous_page_url: null,
  }));

  app.post('/v2/core/account_links', async (request) => {
    const body = request.body ?? {};
    const account = state.accounts.get(body.account);
    if (!account) throw missing('account', body.account);
    const useCase = body.use_case?.account_onboarding ?? body.use_case?.account_update ?? {};
    const configurations = asArray(useCase.configurations);
    const applied = accountView(account).applied_configurations;
    const unknown = configurations.filter((c) => !applied.includes(c));
    if (unknown.length > 0) throw invalid(`The account does not have the ${unknown.join(', ')} configuration.`);
    return {
      object: 'v2.core.account_link',
      account: account.id,
      created: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      livemode: false,
      url: `${baseUrl}/connect/onboard/${account.id}?return=${encodeURIComponent(useCase.return_url ?? '')}`,
      use_case: body.use_case,
    };
  });

  // ── v2 event destinations ──

  const destinationView = ({ webhook_endpoint, ...d }, secret = false) => ({
    ...d,
    webhook_endpoint: { url: webhook_endpoint.url, signing_secret: secret ? webhook_endpoint.signing_secret : null },
  });

  app.get('/v2/core/event_destinations', async () => ({
    data: [...state.destinations.values()].map((d) => destinationView(d)),
    next_page_url: null,
    previous_page_url: null,
  }));

  app.post('/v2/core/event_destinations', async (request) => {
    const body = request.body ?? {};
    const destination = {
      id: id('ed'),
      object: 'v2.core.event_destination',
      name: body.name,
      description: body.description ?? '',
      type: body.type,
      event_payload: body.event_payload,
      events_from: body.events_from ?? ['@self'],
      enabled_events: body.enabled_events ?? [],
      snapshot_api_version: body.event_payload === 'snapshot' ? (body.snapshot_api_version ?? API_VERSION) : null,
      status: 'enabled',
      livemode: false,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      webhook_endpoint: {
        url: body.webhook_endpoint?.url,
        signing_secret: body.event_payload === 'thin' ? SIM_SECRETS.thin : SIM_SECRETS.snapshot,
      },
    };
    state.destinations.set(destination.id, destination);
    return destinationView(destination, asArray(body.include).includes('webhook_endpoint.signing_secret'));
  });

  app.post('/v2/core/event_destinations/:id', async (request) => {
    const destination = state.destinations.get(request.params.id);
    if (!destination) throw missing('event destination', request.params.id);
    if (request.body?.enabled_events) destination.enabled_events = request.body.enabled_events;
    if (request.body?.webhook_endpoint?.url) destination.webhook_endpoint.url = request.body.webhook_endpoint.url;
    destination.updated = new Date().toISOString();
    return destinationView(destination);
  });

  // ── Connected-account helpers ──

  app.post('/v1/account_sessions', async (request) => {
    const account = state.accounts.get(request.body?.account);
    if (!account) throw missing('account', request.body?.account);
    return {
      object: 'account_session',
      account: account.id,
      client_secret: `accs_sim_secret_${randomBytes(8).toString('hex')}`,
      expires_at: now() + 1800,
      livemode: false,
      components: request.body?.components ?? {},
    };
  });

  app.post('/v1/accounts/:id/login_links', async (request) => {
    const account = state.accounts.get(request.params.id);
    if (!account) throw missing('account', request.params.id);
    if (account.dashboard !== 'express') throw invalid('Login links are only available for Express-dashboard accounts.');
    return { object: 'login_link', created: now(), url: `${baseUrl}/express/${account.id}` };
  });

  // ── Customers and payment methods ──

  app.post('/v1/customers', idempotent(async (request) => {
    const customer = {
      id: id('cus'),
      object: 'customer',
      account: accountOf(request),
      email: request.body?.email ?? null,
      name: request.body?.name ?? null,
      metadata: request.body?.metadata ?? {},
    };
    state.customers.set(customer.id, customer);
    const { account: _account, ...view } = customer;
    return view;
  }));

  function newMethod(account, customer, card = {}) {
    const method = { id: id('pm'), account, customer, brand: card.brand ?? 'visa', last4: card.last4 ?? '4242' };
    state.methods.set(method.id, method);
    return method;
  }

  app.get('/v1/customers/:id/payment_methods', async (request) => {
    const account = accountOf(request);
    own(state.customers, 'customer', request.params.id, account);
    const data = [...state.methods.values()].filter((m) => m.account === account && m.customer === request.params.id).map(methodView);
    return list(data, `/v1/customers/${request.params.id}/payment_methods`);
  });

  app.get('/v1/payment_methods/:id', async (request) => methodView(own(state.methods, 'payment_method', request.params.id, accountOf(request))));

  app.post('/v1/payment_methods/:id/detach', async (request) => {
    const account = accountOf(request);
    const method = own(state.methods, 'payment_method', request.params.id, account);
    if (!method.customer) throw invalid('The payment method is not attached to a customer.');
    method.customer = null;
    later(() => emit('payment_method.detached', account, methodView(method)));
    return methodView(method);
  });

  // ── Products, prices, entitlement features, meters ──

  app.get('/v1/products/:id', async (request) => productView(own(state.products, 'product', request.params.id, accountOf(request))));

  app.post('/v1/products', idempotent(async (request) => {
    const body = request.body ?? {};
    const productId = body.id ?? id('prod');
    if (state.products.has(productId)) throw invalid(`Product already exists.`, { code: 'resource_already_exists' });
    const product = { id: productId, account: accountOf(request), name: body.name, description: body.description ?? null, active: true, metadata: body.metadata ?? {} };
    state.products.set(product.id, product);
    return productView(product);
  }));

  app.post('/v1/products/:id', async (request) => {
    const product = own(state.products, 'product', request.params.id, accountOf(request));
    const body = request.body ?? {};
    if (body.name !== undefined) product.name = body.name;
    if (body.description !== undefined) product.description = body.description || null;
    if (body.active !== undefined) product.active = truthy(body.active);
    return productView(product);
  });

  const featureView = (f) => ({ id: f.id, object: 'entitlements.feature', lookup_key: f.lookup_key, name: f.name, active: f.active, metadata: f.metadata });

  app.get('/v1/products/:id/features', async (request) => {
    own(state.products, 'product', request.params.id, accountOf(request));
    const data = (state.productFeatures.get(request.params.id) ?? []).map((a) => ({
      id: a.id,
      object: 'product_feature',
      entitlement_feature: featureView(state.features.get(a.feature)),
    }));
    return list(data, `/v1/products/${request.params.id}/features`);
  });

  app.post('/v1/products/:id/features', async (request) => {
    own(state.products, 'product', request.params.id, accountOf(request));
    const feature = state.features.get(request.body?.entitlement_feature);
    if (!feature) throw missing('feature', request.body?.entitlement_feature);
    const attached = state.productFeatures.get(request.params.id) ?? [];
    if (attached.some((a) => a.feature === feature.id)) throw invalid('This feature is already attached to the product.');
    const attachment = { id: id('prodft'), feature: feature.id };
    state.productFeatures.set(request.params.id, [...attached, attachment]);
    return { id: attachment.id, object: 'product_feature', entitlement_feature: featureView(feature) };
  });

  app.delete('/v1/products/:id/features/:attachment', async (request) => {
    own(state.products, 'product', request.params.id, accountOf(request));
    const attached = state.productFeatures.get(request.params.id) ?? [];
    state.productFeatures.set(request.params.id, attached.filter((a) => a.id !== request.params.attachment));
    return { id: request.params.attachment, object: 'product_feature', deleted: true };
  });

  app.get('/v1/entitlements/features', async (request) => {
    const lookupKey = parseQuery(request.url).lookup_key;
    const data = [...state.features.values()].filter((f) => !lookupKey || f.lookup_key === lookupKey).map(featureView);
    return list(data, '/v1/entitlements/features');
  });

  app.post('/v1/entitlements/features', async (request) => {
    const body = request.body ?? {};
    if ([...state.features.values()].some((f) => f.lookup_key === body.lookup_key)) {
      throw invalid(`A feature with lookup_key ${body.lookup_key} already exists.`);
    }
    const feature = { id: id('feat'), lookup_key: body.lookup_key, name: body.name, active: true, metadata: body.metadata ?? {} };
    state.features.set(feature.id, feature);
    return featureView(feature);
  });

  app.post('/v1/entitlements/features/:id', async (request) => {
    const feature = state.features.get(request.params.id);
    if (!feature) throw missing('feature', request.params.id);
    if (request.body?.name !== undefined) feature.name = request.body.name;
    if (request.body?.active !== undefined) feature.active = truthy(request.body.active);
    return featureView(feature);
  });

  function createPrice(account, body) {
    const lookupKey = body.lookup_key ?? null;
    if (lookupKey) {
      const holder = [...state.prices.values()].find((p) => p.account === account && p.lookup_key === lookupKey);
      if (holder && !truthy(body.transfer_lookup_key)) {
        throw invalid(`A price (\`${holder.id}\`) already uses that lookup key.`, { code: 'lookup_key_already_used' });
      }
      if (holder) holder.lookup_key = null;
    }
    let product = body.product;
    if (!product && body.product_data) {
      product = id('prod');
      state.products.set(product, { id: product, account, name: body.product_data.name, description: body.product_data.description ?? null, active: true, metadata: {} });
    }
    if (!product || !state.products.has(product)) throw invalid('A price needs a product (product or product_data).');
    const recurring = body.recurring
      ? {
          interval: body.recurring.interval,
          interval_count: int(body.recurring.interval_count, 1),
          usage_type: body.recurring.usage_type ?? 'licensed',
          meter: body.recurring.meter ?? null,
        }
      : null;
    if (recurring?.usage_type === 'metered' && !state.meters.has(recurring.meter)) throw invalid('Metered prices need a meter.');
    const custom = body.custom_unit_amount && truthy(body.custom_unit_amount.enabled)
      ? {
          minimum: body.custom_unit_amount.minimum ? Number(body.custom_unit_amount.minimum) : null,
          maximum: body.custom_unit_amount.maximum ? Number(body.custom_unit_amount.maximum) : null,
          preset: body.custom_unit_amount.preset ? Number(body.custom_unit_amount.preset) : null,
        }
      : null;
    const unitAmount = body.unit_amount !== undefined ? Number(body.unit_amount) : null;
    const price = {
      id: id('price'),
      account,
      active: true,
      currency: body.currency,
      lookup_key: lookupKey,
      unit_amount: unitAmount ?? (body.unit_amount_decimal && Number.isInteger(Number(body.unit_amount_decimal)) ? Number(body.unit_amount_decimal) : null),
      unit_amount_decimal: body.unit_amount_decimal ?? (unitAmount !== null ? String(unitAmount) : null),
      custom_unit_amount: custom,
      product,
      recurring,
      metadata: body.metadata ?? {},
    };
    state.prices.set(price.id, price);
    return price;
  }

  app.post('/v1/prices', idempotent(async (request) => priceView(createPrice(accountOf(request), request.body ?? {}))));

  app.get('/v1/prices', async (request) => {
    const account = accountOf(request);
    const keys = asArray(parseQuery(request.url).lookup_keys);
    if (keys.length > 10) throw invalid('You can pass at most 10 lookup_keys.');
    const data = [...state.prices.values()]
      .filter((p) => p.account === account && (keys.length === 0 || keys.includes(p.lookup_key)))
      .map((p) => priceView(p));
    return list(data, '/v1/prices');
  });

  app.post('/v1/prices/:id', async (request) => {
    const price = own(state.prices, 'price', request.params.id, accountOf(request));
    if (request.body?.active !== undefined) price.active = truthy(request.body.active);
    return priceView(price);
  });

  const meterView = (m) => ({
    id: m.id,
    object: 'billing.meter',
    display_name: m.display_name,
    event_name: m.event_name,
    default_aggregation: { formula: m.formula },
    customer_mapping: { type: 'by_id', event_payload_key: m.customer_key },
    value_settings: { event_payload_key: m.value_key },
    status: 'active',
  });

  app.get('/v1/billing/meters', async () => list([...state.meters.values()].map(meterView), '/v1/billing/meters'));

  app.post('/v1/billing/meters', async (request) => {
    const body = request.body ?? {};
    if ([...state.meters.values()].some((m) => m.event_name === body.event_name)) {
      throw invalid(`An active meter with event_name ${body.event_name} already exists.`);
    }
    const meter = {
      id: id('mtr'),
      display_name: body.display_name,
      event_name: body.event_name,
      formula: body.default_aggregation?.formula ?? 'sum',
      customer_key: body.customer_mapping?.event_payload_key ?? 'stripe_customer_id',
      value_key: body.value_settings?.event_payload_key ?? 'value',
    };
    state.meters.set(meter.id, meter);
    return meterView(meter);
  });

  app.post('/v1/billing/meters/:id', async (request) => {
    const meter = state.meters.get(request.params.id);
    if (!meter) throw missing('meter', request.params.id);
    if (request.body?.display_name) meter.display_name = request.body.display_name;
    return meterView(meter);
  });

  app.post('/v1/billing/meter_events', async (request) => {
    const body = request.body ?? {};
    const meter = [...state.meters.values()].find((m) => m.event_name === body.event_name);
    if (!meter) throw invalid(`No active meter found for event_name ${body.event_name}.`);
    const customer = body.payload?.[meter.customer_key];
    if (!customer || !state.customers.has(customer)) throw invalid('The meter event names no known customer.');
    const value = Number(body.payload?.[meter.value_key]);
    const timestamp = int(body.timestamp, now());
    if (timestamp < now() - 35 * DAY || timestamp > now() + 300) throw invalid('Meter event timestamps must be within the past 35 days and at most 5 minutes in the future.');
    const identifier = body.identifier ?? id('mev');
    // Stripe counts one event per identifier.
    if (!state.meterEvents.some((e) => e.identifier === identifier)) {
      state.meterEvents.push({ identifier, event_name: body.event_name, customer, value, timestamp });
    }
    return { object: 'billing.meter_event', event_name: body.event_name, identifier, payload: body.payload, timestamp };
  });

  /** Features granted by the live subscriptions of a platform customer. */
  function activeFeatures(customer) {
    const features = new Map();
    for (const sub of state.subscriptions.values()) {
      if (sub.customer !== customer || sub.account !== null) continue;
      if (!['active', 'trialing', 'past_due'].includes(sub.status)) continue;
      for (const item of sub.items) {
        const product = state.prices.get(item.price)?.product;
        for (const a of state.productFeatures.get(product) ?? []) {
          const feature = state.features.get(a.feature);
          if (feature?.active) features.set(feature.id, feature);
        }
      }
    }
    return [...features.values()];
  }

  app.get('/v1/entitlements/active_entitlements', async (request) => {
    const customer = parseQuery(request.url).customer;
    const data = activeFeatures(customer).map((f) => ({ id: id('ent'), object: 'entitlements.active_entitlement', feature: f.id, lookup_key: f.lookup_key, livemode: false }));
    return list(data, '/v1/entitlements/active_entitlements');
  });

  const emitEntitlements = (customer) =>
    emit('entitlements.active_entitlement_summary.updated', null, {
      object: 'entitlements.active_entitlement_summary',
      customer,
      livemode: false,
      entitlements: { object: 'list', data: activeFeatures(customer).map((f) => ({ feature: f.id, lookup_key: f.lookup_key })) },
    });

  // ── Checkout Sessions ──

  function lineItemsOf(account, body) {
    return asArray(body.line_items).map((item) => {
      let price = item.price ? own(state.prices, 'price', item.price, account) : null;
      if (!price && item.price_data) {
        price = createPrice(account, {
          currency: item.price_data.currency,
          unit_amount: item.price_data.unit_amount,
          product_data: item.price_data.product_data,
          product: item.price_data.product,
          recurring: item.price_data.recurring,
        });
      }
      if (!price) throw invalid('Each line item needs a price or price_data.');
      if (!price.active) throw invalid(`The price ${price.id} is not active.`);
      const metered = price.recurring?.usage_type === 'metered';
      if (metered && item.quantity !== undefined) throw invalid('Quantity cannot be set for metered prices.');
      return { price: price.id, quantity: metered ? null : int(item.quantity, 1) };
    });
  }

  const unitOf = (price) => price.unit_amount ?? price.custom_unit_amount?.preset ?? price.custom_unit_amount?.minimum ?? 0;

  app.post('/v1/checkout/sessions', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    const mode = body.mode ?? 'payment';
    const uiMode = body.ui_mode ?? 'hosted_page';
    if (!['hosted_page', 'embedded_page'].includes(uiMode)) throw invalid(`The simulator does not implement ui_mode ${uiMode}.`);
    if (uiMode === 'embedded_page' && (!body.return_url || body.success_url)) throw invalid('Embedded pages take return_url, not success_url.');
    if (uiMode === 'hosted_page' && !body.success_url) throw invalid('Hosted pages need success_url.');
    if (account && mode !== 'setup') requireCards(account);
    const customer = body.customer ? own(state.customers, 'customer', body.customer, account) : null;
    const expiresAt = int(body.expires_at, now() + DAY);
    if (expiresAt < now() + 30 * 60 || expiresAt > now() + DAY) {
      throw invalid('The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session creation.', { param: 'expires_at' });
    }

    const session = {
      id: id('cs_test'),
      secret: randomBytes(6).toString('hex'),
      account,
      mode,
      ui_mode: uiMode,
      status: 'open',
      payment_status: mode === 'setup' ? 'no_payment_required' : 'unpaid',
      currency: body.currency ?? null,
      items: [],
      amount_subtotal: 0,
      amount_total: 0,
      amount_discount: 0,
      amount_tax: 0,
      automatic_tax: truthy(body.automatic_tax?.enabled),
      allow_promotion_codes: truthy(body.allow_promotion_codes),
      metadata: body.metadata ?? {},
      client_reference_id: body.client_reference_id ?? null,
      customer: customer?.id ?? null,
      customer_creation: body.customer_creation ?? null,
      customer_email: body.customer_email ?? customer?.email ?? null,
      success_url: body.success_url,
      cancel_url: body.cancel_url,
      return_url: body.return_url,
      expires_at: expiresAt,
      payment_intent: null,
      payment_link: body.payment_link ?? null,
      subscription: null,
      setup_intent: null,
      pi: null,
      sub: null,
    };

    if (mode === 'setup') {
      if (!customer) throw invalid('Setup mode needs a customer.');
      if (!body.currency && asArray(body.payment_method_types).length === 0) {
        throw invalid('currency is required in setup mode when payment_method_types is not set.', { param: 'currency' });
      }
    } else {
      session.items = lineItemsOf(account, body);
      if (session.items.length === 0) throw invalid('line_items is required.');
      const prices = session.items.map((item) => state.prices.get(item.price));
      session.currency = prices[0].currency;
      session.custom = prices.find((p) => p.custom_unit_amount) ?? null;
      session.amount_subtotal = session.items.reduce((sum, item, i) => sum + unitOf(prices[i]) * (item.quantity ?? 0), 0);
      session.amount_total = session.amount_subtotal;
      if (mode === 'payment') {
        if (prices.some((p) => p.recurring)) throw invalid('Payment mode takes one-time prices only.');
        if (!session.custom && session.amount_subtotal < (MIN_AMOUNT[session.currency] ?? 50)) {
          throw invalid(`The Checkout Session's total amount due must add up to at least ${MIN_AMOUNT[session.currency] ?? 50} ${session.currency}`, { code: 'amount_too_small', param: 'line_items[0][price_data][unit_amount]' });
        }
        const data = body.payment_intent_data ?? {};
        session.pi = {
          ...checkMoneyRouting(account, data, session.amount_subtotal),
          metadata: data.metadata ?? {},
          capture_method: data.capture_method ?? 'automatic_async',
          setup_future_usage: data.setup_future_usage ?? null,
          description: data.description ?? null,
        };
        if (session.pi.setup_future_usage && !customer && body.customer_creation !== 'always') {
          throw invalid('Saving a payment method needs a customer or customer_creation=always.');
        }
      } else {
        if (!customer) throw invalid('Subscription mode needs a customer.');
        if (prices.some((p) => !p.recurring)) throw invalid('Subscription mode takes recurring prices.');
        const data = body.subscription_data ?? {};
        const percent = data.application_fee_percent !== undefined ? Number(data.application_fee_percent) : null;
        if (percent !== null && !/^\d+(\.\d{1,2})?$/.test(String(data.application_fee_percent))) {
          throw invalid('application_fee_percent takes at most two decimals.');
        }
        const destination = data.transfer_data?.destination ?? null;
        if ((destination || data.on_behalf_of) && account) throw invalid('transfer_data and on_behalf_of can only be used by the platform.');
        if (destination) requireTransfers(destination);
        session.sub = {
          metadata: data.metadata ?? {},
          application_fee_percent: percent,
          trial_period_days: int(data.trial_period_days, 0),
          transfer_data: destination ? { destination } : null,
          on_behalf_of: data.on_behalf_of ?? null,
        };
      }
    }
    state.sessions.set(session.id, session);
    return sessionView(session, expandOf(request));
  }));

  app.get('/v1/checkout/sessions/:id', async (request) =>
    sessionView(own(state.sessions, 'checkout.session', request.params.id, accountOf(request)), expandOf(request)),
  );

  app.get('/v1/checkout/sessions', async (request) => {
    const account = accountOf(request);
    const query = parseQuery(request.url);
    const expand = under(new Set(asArray(query.expand)), 'data.');
    const data = [...state.sessions.values()]
      .filter((s) => s.account === account && (!query.payment_intent || s.payment_intent === query.payment_intent))
      .map((s) => sessionView(s, expand));
    return list(data, '/v1/checkout/sessions');
  });

  app.post('/v1/checkout/sessions/:id/expire', async (request) => {
    const session = own(state.sessions, 'checkout.session', request.params.id, accountOf(request));
    if (session.status !== 'open') throw invalid(`Only open sessions can be expired; this one is ${session.status}.`);
    session.status = 'expired';
    later(() => emit('checkout.session.expired', session.account, sessionView(session)));
    return sessionView(session, expandOf(request));
  });

  // ── PaymentIntents ──

  function newIntent(account, fields) {
    const pi = {
      id: id('pi'),
      account,
      status: 'requires_payment_method',
      amount_received: 0,
      amount_capturable: 0,
      charge: null,
      last_payment_error: null,
      metadata: {},
      ...fields,
    };
    state.intents.set(pi.id, pi);
    return pi;
  }

  /** Charge the method: succeeded (or held for manual capture). */
  function succeed(pi) {
    pi.charge = { id: id('ch'), amount_refunded: 0, created: now() };
    if (pi.capture_method === 'manual') {
      Object.assign(pi, { status: 'requires_capture', amount_capturable: pi.amount });
    } else {
      Object.assign(pi, { status: 'succeeded', amount_received: pi.amount });
    }
  }

  app.post('/v1/payment_intents', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    if (account) requireCards(account);
    const amount = int(body.amount);
    const customer = body.customer ? own(state.customers, 'customer', body.customer, account) : null;
    const method = body.payment_method ? own(state.methods, 'payment_method', body.payment_method, account) : null;
    if (method && method.customer !== customer?.id) throw invalid('The payment method is not attached to this customer.');
    const pi = newIntent(account, {
      amount,
      currency: body.currency,
      customer: customer?.id ?? null,
      payment_method: method?.id ?? null,
      capture_method: body.capture_method ?? 'automatic',
      setup_future_usage: body.setup_future_usage ?? null,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
      ...checkMoneyRouting(account, body, amount),
    });
    if (!truthy(body.confirm)) return intentView(pi, expandOf(request));
    const outcome = state.nextOffSession ?? 'succeeded';
    state.nextOffSession = null;
    if (outcome !== 'succeeded') {
      pi.last_payment_error = { code: outcome, decline_code: outcome === 'card_declined' ? 'insufficient_funds' : null, type: 'card_error' };
      later(() => emit('payment_intent.payment_failed', account, intentView(pi)));
      throw new StripeFailure(402, 'card_error', outcome === 'authentication_required' ? 'Your card was declined. This transaction requires authentication.' : 'Your card was declined.', {
        code: outcome,
        ...(outcome === 'card_declined' ? { decline_code: 'insufficient_funds' } : {}),
        payment_intent: intentView(pi),
      });
    }
    succeed(pi);
    later(() => emit(pi.status === 'requires_capture' ? 'payment_intent.amount_capturable_updated' : 'payment_intent.succeeded', account, intentView(pi)));
    return intentView(pi, expandOf(request));
  }));

  app.get('/v1/payment_intents/:id', async (request) =>
    intentView(own(state.intents, 'payment_intent', request.params.id, accountOf(request)), expandOf(request)),
  );

  app.post('/v1/payment_intents/:id/capture', idempotent(async (request) => {
    const account = accountOf(request);
    const pi = own(state.intents, 'payment_intent', request.params.id, account);
    if (pi.status !== 'requires_capture') throw invalid(`This PaymentIntent could not be captured because it has a status of ${pi.status}.`, { code: 'payment_intent_unexpected_state' });
    const amount = int(request.body?.amount_to_capture, pi.amount_capturable);
    if (amount > pi.amount_capturable) throw invalid(`amount_to_capture (${amount}) exceeds the amount capturable (${pi.amount_capturable}).`);
    if (request.body?.application_fee_amount !== undefined) pi.application_fee_amount = int(request.body.application_fee_amount);
    if ((pi.application_fee_amount ?? 0) > amount) throw invalid('The application fee cannot exceed the captured amount.');
    Object.assign(pi, { status: 'succeeded', amount_received: amount, amount_capturable: 0 });
    later(() => emit('payment_intent.succeeded', account, intentView(pi)));
    return intentView(pi, expandOf(request));
  }));

  app.post('/v1/payment_intents/:id/cancel', async (request) => {
    const account = accountOf(request);
    const pi = own(state.intents, 'payment_intent', request.params.id, account);
    if (['succeeded', 'canceled'].includes(pi.status)) throw invalid(`You cannot cancel this PaymentIntent because it has a status of ${pi.status}.`);
    Object.assign(pi, { status: 'canceled', amount_capturable: 0 });
    later(() => emit('payment_intent.canceled', account, intentView(pi)));
    return intentView(pi, expandOf(request));
  });

  // ── Refunds and disputes ──

  app.post('/v1/refunds', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    const pi = own(state.intents, 'payment_intent', body.payment_intent, account);
    if (!pi.charge || pi.status !== 'succeeded') throw invalid('This PaymentIntent has no successful charge to refund.');
    if (truthy(body.reverse_transfer) && !pi.transfer_data) throw invalid('reverse_transfer can only be used on destination charges.');
    if (truthy(body.refund_application_fee) && account === null && !pi.transfer_data && !pi.application_fee_amount) {
      throw invalid('refund_application_fee can only be used on charges with an application fee.');
    }
    const pending = [...state.refunds.values()].filter((r) => r.payment_intent === pi.id && r.status === 'pending').reduce((sum, r) => sum + r.amount, 0);
    const remaining = pi.amount_received - pi.charge.amount_refunded - pending;
    const amount = body.amount ? Number(body.amount) : remaining;
    if (amount <= 0 || amount > remaining) {
      throw invalid(`Refund amount (${amount}) is greater than unrefunded amount on charge (${remaining})`, { code: 'amount_too_large' });
    }
    const refund = {
      id: id('re'),
      account,
      amount,
      currency: pi.currency,
      status: 'pending',
      reason: body.reason ?? null,
      failure_reason: null,
      metadata: body.metadata ?? {},
      payment_intent: pi.id,
      charge: pi.charge.id,
      reverse_transfer: truthy(body.reverse_transfer),
      refund_application_fee: truthy(body.refund_application_fee),
    };
    state.refunds.set(refund.id, refund);
    later(() => emit('refund.created', account, refundView(refund)));
    return refundView(refund);
  }));

  app.get('/v1/refunds/:id', async (request) => refundView(own(state.refunds, 'refund', request.params.id, accountOf(request))));

  app.get('/v1/refunds', async (request) => {
    const account = accountOf(request);
    const query = parseQuery(request.url);
    const data = [...state.refunds.values()]
      .filter((r) => r.account === account && (!query.charge || r.charge === query.charge) && (!query.payment_intent || r.payment_intent === query.payment_intent))
      .map(refundView);
    return list(data, '/v1/refunds');
  });

  app.get('/v1/disputes/:id', async (request) => disputeView(own(state.disputes, 'dispute', request.params.id, accountOf(request))));

  const EVIDENCE_FIELDS = ['product_description', 'customer_name', 'customer_email_address', 'service_date', 'refund_policy_disclosure', 'cancellation_policy_disclosure', 'uncategorized_text'];

  app.post('/v1/disputes/:id', async (request) => {
    const account = accountOf(request);
    const dispute = own(state.disputes, 'dispute', request.params.id, account);
    if (dispute.submission_count > 0 || !['needs_response', 'warning_needs_response'].includes(dispute.status)) {
      throw invalid('This dispute is already closed or its evidence was submitted.');
    }
    for (const [key, value] of Object.entries(request.body?.evidence ?? {})) {
      if (!EVIDENCE_FIELDS.includes(key)) throw invalid(`The simulator does not take evidence[${key}].`);
      dispute.evidence[key] = value;
    }
    if (truthy(request.body?.submit)) Object.assign(dispute, { submission_count: 1, status: 'under_review' });
    later(() => emit('charge.dispute.updated', account, disputeView(dispute)));
    return disputeView(dispute);
  });

  app.post('/v1/disputes/:id/close', async (request) => {
    const account = accountOf(request);
    const dispute = own(state.disputes, 'dispute', request.params.id, account);
    if (['won', 'lost'].includes(dispute.status)) throw invalid('This dispute is already closed.');
    dispute.status = 'lost';
    later(() => emit('charge.dispute.closed', account, disputeView(dispute)));
    return disputeView(dispute);
  });

  // ── Billing portal ──

  app.get('/v1/billing_portal/configurations', async (request) => {
    const account = accountOf(request) ?? '';
    const query = parseQuery(request.url);
    const data = (state.portalConfigurations.get(account) ?? []).filter(
      (c) => (query.is_default === undefined || c.is_default === truthy(query.is_default)) && (query.active === undefined || c.active === truthy(query.active)),
    );
    return list(data, '/v1/billing_portal/configurations');
  });

  app.post('/v1/billing_portal/configurations', async (request) => {
    const account = accountOf(request) ?? '';
    const existing = state.portalConfigurations.get(account) ?? [];
    const configuration = { id: id('bpc'), object: 'billing_portal.configuration', active: true, is_default: existing.length === 0, name: request.body?.name ?? null, features: request.body?.features ?? {} };
    state.portalConfigurations.set(account, [...existing, configuration]);
    return configuration;
  });

  app.post('/v1/billing_portal/sessions', async (request) => {
    const account = accountOf(request);
    const customer = own(state.customers, 'customer', request.body?.customer, account);
    const configurations = state.portalConfigurations.get(account ?? '') ?? [];
    const configuration = request.body?.configuration
      ? configurations.find((c) => c.id === request.body.configuration)
      : configurations.find((c) => c.is_default);
    if (!configuration) {
      throw invalid('No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal.');
    }
    const session = { id: id('bps'), customer: customer.id, account, return_url: request.body?.return_url, configuration: configuration.id };
    state.portalSessions.push(session);
    return { id: session.id, object: 'billing_portal.session', url: `${baseUrl}/portal/${session.id}`, return_url: session.return_url, configuration: configuration.id };
  });

  // ── Subscriptions ──

  function newSubscription(account, customer, items, options) {
    const trialDays = options.trial_period_days ?? 0;
    const sub = {
      id: id('sub'),
      account,
      customer,
      status: trialDays > 0 ? 'trialing' : 'active',
      currency: state.prices.get(items[0].price).currency,
      metadata: options.metadata ?? {},
      cancel_at_period_end: false,
      canceled_at: null,
      ended_at: null,
      trial_end: trialDays > 0 ? now() + trialDays * DAY : null,
      current_period_end: now() + (trialDays > 0 ? trialDays : 30) * DAY,
      latest_invoice: null,
      application_fee_percent: options.application_fee_percent ?? null,
      transfer_data: options.transfer_data ?? null,
      on_behalf_of: options.on_behalf_of ?? null,
      items: items.map((item) => ({ id: id('si'), price: item.price, quantity: item.quantity })),
    };
    state.subscriptions.set(sub.id, sub);
    return sub;
  }

  function subscriptionAmount(sub) {
    return sub.items.reduce((sum, item) => sum + (state.prices.get(item.price).unit_amount ?? 0) * (item.quantity ?? 0), 0);
  }

  /** A subscription invoice for the period, paid or failed. */
  function billSubscription(sub, { paid, reason }) {
    const amount = sub.status === 'trialing' ? 0 : subscriptionAmount(sub);
    const inv = newInvoice(sub.account, {
      customer: sub.customer,
      currency: sub.currency,
      subscription: sub.id,
      billing_reason: reason,
      collection_method: 'charge_automatically',
      metadata: {},
      lines: [{ id: id('il'), amount, description: 'Subscription' }],
      subtotal: amount,
      application_fee_amount: sub.application_fee_percent ? Math.round((amount * sub.application_fee_percent) / 100) : null,
    });
    Object.assign(inv, { status: 'open', number: `SIM-${counter}`, finalized_at: now(), period_start: now(), period_end: sub.current_period_end });
    sub.latest_invoice = inv.id;
    if (paid) {
      payInvoice(inv);
    } else {
      inv.attempt_count = 1;
      sub.status = 'past_due';
    }
    return inv;
  }

  app.get('/v1/subscriptions/:id', async (request) =>
    subscriptionView(own(state.subscriptions, 'subscription', request.params.id, accountOf(request)), expandOf(request)),
  );

  app.post('/v1/subscriptions/:id', idempotent(async (request) => {
    const account = accountOf(request);
    const sub = own(state.subscriptions, 'subscription', request.params.id, account);
    if (['canceled', 'incomplete_expired'].includes(sub.status)) throw invalid('A canceled subscription can only update its cancellation_details and metadata.');
    const body = request.body ?? {};
    for (const change of asArray(body.items)) {
      const existing = change.id ? sub.items.find((i) => i.id === change.id) : null;
      if (change.id && !existing) throw missing('subscription_item', change.id);
      if (truthy(change.deleted)) {
        sub.items = sub.items.filter((i) => i !== existing);
        continue;
      }
      const price = change.price ? own(state.prices, 'price', change.price, account) : null;
      if (existing) {
        if (price) existing.price = price.id;
        if (change.quantity !== undefined) existing.quantity = int(change.quantity);
      } else {
        if (!price) throw invalid('New items need a price.');
        sub.items.push({ id: id('si'), price: price.id, quantity: price.recurring?.usage_type === 'metered' ? null : int(change.quantity, 1) });
      }
    }
    if (body.cancel_at_period_end !== undefined) sub.cancel_at_period_end = truthy(body.cancel_at_period_end);
    later(async () => {
      await emit('customer.subscription.updated', account, subscriptionView(sub));
      if (account === null) await emitEntitlements(sub.customer);
    });
    return subscriptionView(sub, expandOf(request));
  }));

  app.delete('/v1/subscriptions/:id', idempotent(async (request) => {
    const account = accountOf(request);
    const sub = own(state.subscriptions, 'subscription', request.params.id, account);
    Object.assign(sub, { status: 'canceled', canceled_at: now(), ended_at: now() });
    later(async () => {
      await emit('customer.subscription.deleted', account, subscriptionView(sub));
      if (account === null) await emitEntitlements(sub.customer);
    });
    return subscriptionView(sub, expandOf(request));
  }));

  // ── Invoices ──

  function newInvoice(account, fields) {
    const inv = {
      id: id('in'),
      account,
      status: 'draft',
      number: null,
      due_date: null,
      paid_at: null,
      finalized_at: null,
      attempt_count: 0,
      payment_intent: null,
      subscription: null,
      period_start: now(),
      period_end: now(),
      sent: false,
      lines: [],
      subtotal: 0,
      ...fields,
    };
    state.invoices.set(inv.id, inv);
    return inv;
  }

  function payInvoice(inv) {
    const pi = newIntent(inv.account, {
      amount: inv.subtotal,
      currency: inv.currency,
      customer: inv.customer,
      capture_method: 'automatic',
      application_fee_amount: inv.application_fee_amount,
      transfer_data: inv.transfer_data ?? null,
      on_behalf_of: inv.on_behalf_of ?? null,
      metadata: {},
    });
    succeed(pi);
    Object.assign(inv, { status: 'paid', paid_at: now(), payment_intent: pi.id, attempt_count: inv.attempt_count + 1 });
    return pi;
  }

  app.get('/v1/invoices', async (request) => {
    const account = accountOf(request);
    const query = parseQuery(request.url);
    const data = [...state.invoices.values()]
      .filter((inv) => inv.account === account && (!query.customer || inv.customer === query.customer))
      .reverse()
      .map((inv) => invoiceView(inv));
    return list(data, '/v1/invoices');
  });

  app.post('/v1/invoices', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    if (account) requireCards(account);
    const customer = own(state.customers, 'customer', body.customer, account);
    if (body.collection_method === 'send_invoice' && !body.days_until_due) throw invalid('send_invoice invoices need days_until_due.');
    const routing = checkMoneyRouting(account, body, Number.MAX_SAFE_INTEGER);
    const inv = newInvoice(account, {
      customer: customer.id,
      currency: body.currency ?? 'usd',
      collection_method: body.collection_method ?? 'charge_automatically',
      days_until_due: int(body.days_until_due, 0),
      description: body.description ?? null,
      metadata: body.metadata ?? {},
      billing_reason: 'manual',
      ...routing,
    });
    return invoiceView(inv, expandOf(request));
  }));

  app.post('/v1/invoiceitems', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    const inv = own(state.invoices, 'invoice', body.invoice, account);
    if (inv.status !== 'draft') throw invalid('Items can only be added to draft invoices.');
    if (inv.customer !== body.customer) throw invalid('The invoice belongs to another customer.');
    const quantity = int(body.quantity, 1);
    const unit = Number(body.unit_amount_decimal ?? body.amount ?? 0);
    const line = { id: id('il'), amount: Math.round(unit * quantity), quantity, description: body.description ?? null };
    inv.lines.push(line);
    inv.subtotal += line.amount;
    return { id: id('ii'), object: 'invoiceitem', invoice: inv.id, amount: line.amount, quantity, description: line.description };
  }));

  app.get('/v1/invoices/:id', async (request) =>
    invoiceView(own(state.invoices, 'invoice', request.params.id, accountOf(request)), expandOf(request)),
  );

  app.post('/v1/invoices/:id/finalize', idempotent(async (request) => {
    const account = accountOf(request);
    const inv = own(state.invoices, 'invoice', request.params.id, account);
    if (inv.status !== 'draft') throw invalid(`This invoice is already ${inv.status}.`);
    if ((inv.application_fee_amount ?? 0) > inv.subtotal) throw invalid('The application fee cannot exceed the invoice total.');
    if (inv.subtotal < (MIN_AMOUNT[inv.currency] ?? 50)) throw invalid('Invoices must be at least the minimum charge amount.');
    Object.assign(inv, { status: 'open', number: `SIM-${counter}`, finalized_at: now(), due_date: now() + inv.days_until_due * DAY });
    later(() => emit('invoice.finalized', account, invoiceView(inv)));
    return invoiceView(inv, expandOf(request));
  }));

  app.post('/v1/invoices/:id/send', idempotent(async (request) => {
    const inv = own(state.invoices, 'invoice', request.params.id, accountOf(request));
    if (inv.status !== 'open' || inv.collection_method !== 'send_invoice') throw invalid('Only open send_invoice invoices can be sent.');
    inv.sent = true;
    return invoiceView(inv, expandOf(request));
  }));

  app.post('/v1/invoices/:id/void', async (request) => {
    const account = accountOf(request);
    const inv = own(state.invoices, 'invoice', request.params.id, account);
    if (inv.status !== 'open') throw invalid(`You can only void an open invoice; this one is ${inv.status}.`);
    inv.status = 'void';
    later(() => emit('invoice.voided', account, invoiceView(inv)));
    return invoiceView(inv, expandOf(request));
  });

  app.delete('/v1/invoices/:id', async (request) => {
    const inv = own(state.invoices, 'invoice', request.params.id, accountOf(request));
    if (inv.status !== 'draft') throw invalid('Only draft invoices can be deleted.');
    state.invoices.delete(inv.id);
    return { id: inv.id, object: 'invoice', deleted: true };
  });

  app.get('/v1/invoice_payments', async (request) => {
    const account = accountOf(request);
    const query = parseQuery(request.url);
    const pi = query.payment?.payment_intent;
    const data = [...state.invoices.values()]
      .filter((inv) => inv.account === account && inv.payment_intent && (!pi || inv.payment_intent === pi))
      .map((inv) => ({ id: `inpay_${inv.id}`, object: 'invoice_payment', invoice: inv.id, status: inv.status === 'paid' ? 'paid' : 'open', payment: { type: 'payment_intent', payment_intent: inv.payment_intent } }));
    return list(data, '/v1/invoice_payments');
  });

  // ── Payment links ──

  app.post('/v1/payment_links', idempotent(async (request) => {
    const account = accountOf(request);
    const body = request.body ?? {};
    if (account) requireCards(account);
    const items = asArray(body.line_items).map((item) => {
      const [line] = lineItemsOf(account, { line_items: [{ ...item, adjustable_quantity: undefined }] });
      const adjustable = item.adjustable_quantity && truthy(item.adjustable_quantity.enabled)
        ? { minimum: int(item.adjustable_quantity.minimum, 1), maximum: int(item.adjustable_quantity.maximum, 99) }
        : null;
      return { ...line, adjustable };
    });
    if (items.length === 0) throw invalid('line_items is required.');
    const link = {
      id: id('plink'),
      account,
      active: true,
      items,
      metadata: body.metadata ?? {},
      pi_metadata: body.payment_intent_data?.metadata ?? {},
      transfer_group: body.payment_intent_data?.transfer_group ?? null,
      redirect: body.after_completion?.redirect?.url ?? null,
      allow_promotion_codes: truthy(body.allow_promotion_codes),
      ...checkMoneyRouting(account, body, Number.MAX_SAFE_INTEGER),
    };
    state.links.set(link.id, link);
    return linkView(link);
  }));

  app.post('/v1/payment_links/:id', async (request) => {
    const link = own(state.links, 'payment_link', request.params.id, accountOf(request));
    if (request.body?.active !== undefined) link.active = truthy(request.body.active);
    return linkView(link);
  });

  // ── Transfers (platform → seller) ──

  app.post('/v1/transfers', idempotent(async (request) => {
    if (request.headers['stripe-account']) throw invalid('Transfers are created by the platform.');
    const body = request.body ?? {};
    requireTransfers(body.destination);
    const amount = int(body.amount);
    let source = null;
    if (body.source_transaction) {
      source = [...state.intents.values()].find((pi) => pi.charge?.id === body.source_transaction);
      if (!source || source.account !== null) throw missing('charge', body.source_transaction);
      const already = [...state.transfers.values()].filter((t) => t.source_transaction === body.source_transaction).reduce((sum, t) => sum + t.amount - t.amount_reversed, 0);
      if (already + amount > source.amount_received) {
        throw invalid(`Transfers from ${body.source_transaction} cannot exceed its amount (${source.amount_received}).`, { code: 'balance_insufficient' });
      }
    }
    const transfer = {
      id: id('tr'),
      account: null,
      amount,
      amount_reversed: 0,
      currency: body.currency,
      destination: body.destination,
      transfer_group: body.transfer_group ?? null,
      source_transaction: body.source_transaction ?? null,
      metadata: body.metadata ?? {},
    };
    state.transfers.set(transfer.id, transfer);
    later(() => emit('transfer.created', null, transferView(transfer)));
    return transferView(transfer);
  }));

  app.get('/v1/transfers/:id', async (request) => transferView(own(state.transfers, 'transfer', request.params.id, accountOf(request))));

  app.post('/v1/transfers/:id/reversals', idempotent(async (request) => {
    const transfer = own(state.transfers, 'transfer', request.params.id, accountOf(request));
    const amount = int(request.body?.amount, transfer.amount - transfer.amount_reversed);
    if (amount <= 0 || amount > transfer.amount - transfer.amount_reversed) throw invalid('The reversal exceeds what is left of the transfer.');
    transfer.amount_reversed += amount;
    later(() => emit('transfer.reversed', null, transferView(transfer)));
    return { id: id('trr'), object: 'transfer_reversal', amount, transfer: transfer.id, metadata: request.body?.metadata ?? {} };
  }));

  // ── Payouts and balance settings ──

  const settingsOf = (accountId) => {
    let settings = state.balanceSettings.get(accountId);
    if (!settings) {
      settings = { interval: 'daily', weekly: [], monthly: [], delay_days: 2, delay_override: null };
      state.balanceSettings.set(accountId, settings);
    }
    return settings;
  };

  const settingsView = (s) => ({
    object: 'balance_settings',
    payments: {
      debit_negative_balances: true,
      payouts: {
        schedule: {
          interval: s.interval,
          ...(s.interval === 'weekly' ? { weekly_payout_days: s.weekly } : {}),
          ...(s.interval === 'monthly' ? { monthly_payout_days: s.monthly } : {}),
        },
        status: 'enabled',
        statement_descriptor: null,
        minimum_balance_by_currency: null,
        automatic_transfer_rules_by_currency: null,
      },
      settlement_timing: {
        delay_days: s.delay_override ?? s.delay_days,
        ...(s.delay_override !== null ? { delay_days_override: s.delay_override } : {}),
        start_of_day: null,
      },
    },
  });

  function sellerOnly(request) {
    const account = accountOf(request);
    if (!account) throw invalid('This call needs the Stripe-Account header of a connected account.');
    return state.accounts.get(account);
  }

  app.get('/v1/balance_settings', async (request) => settingsView(settingsOf(sellerOnly(request).id)));

  app.post('/v1/balance_settings', async (request) => {
    const account = sellerOnly(request);
    if (account.losses_collector !== 'application') {
      throw new StripeFailure(403, 'invalid_request_error', 'Your platform cannot change payout settings for accounts where Stripe is responsible for losses.', { code: 'platform_account_required' });
    }
    const settings = settingsOf(account.id);
    const schedule = request.body?.payments?.payouts?.schedule;
    if (schedule) {
      const weekly = asArray(schedule.weekly_payout_days);
      if (weekly.some((day) => !WEEKDAYS.includes(day))) throw invalid('weekly_payout_days takes monday to friday.');
      if (schedule.interval === 'weekly' && weekly.length === 0) throw invalid('Weekly payouts need weekly_payout_days.');
      settings.interval = schedule.interval ?? settings.interval;
      settings.weekly = weekly;
      settings.monthly = asArray(schedule.monthly_payout_days).map(Number);
    }
    const timing = request.body?.payments?.settlement_timing;
    if (timing && 'delay_days_override' in timing) {
      if (timing.delay_days_override === '') settings.delay_override = null;
      else {
        const days = Number(timing.delay_days_override);
        if (!(days >= 0 && days <= 31)) throw invalid('delay_days_override takes 0 to 31.');
        settings.delay_override = days;
      }
    }
    return settingsView(settings);
  });

  app.get('/v1/balance', async (request) => {
    const account = accountOf(request);
    const balance = state.balances.get(account ?? '') ?? { available: 0, instant: 0 };
    return {
      object: 'balance',
      livemode: false,
      available: [{ amount: balance.available, currency: 'usd' }],
      pending: [{ amount: 0, currency: 'usd' }],
      ...(account ? { instant_available: [{ amount: balance.instant, currency: 'usd' }] } : {}),
    };
  });

  function newPayout(accountId, fields) {
    const payout = { id: id('po'), account: accountId, status: 'pending', method: 'standard', arrival_date: now() + 2 * DAY, failure_code: null, metadata: {}, currency: 'usd', ...fields };
    state.payouts.set(payout.id, payout);
    return payout;
  }

  app.get('/v1/payouts', async (request) => {
    const account = sellerOnly(request).id;
    const limit = int(parseQuery(request.url).limit, 10);
    const data = [...state.payouts.values()].filter((p) => p.account === account).reverse().slice(0, limit).map(payoutView);
    return list(data, '/v1/payouts');
  });

  app.get('/v1/payouts/:id', async (request) => payoutView(own(state.payouts, 'payout', request.params.id, accountOf(request))));

  app.post('/v1/payouts', idempotent(async (request) => {
    const account = sellerOnly(request);
    const body = request.body ?? {};
    const amount = int(body.amount);
    const method = body.method ?? 'standard';
    const balance = state.balances.get(account.id) ?? { available: 0, instant: 0 };
    if (method === 'instant' && amount > balance.instant) {
      throw invalid(`You have insufficient funds available for an instant payout (${balance.instant} available).`, { code: 'balance_insufficient' });
    }
    if (method === 'instant') balance.instant -= amount;
    state.balances.set(account.id, balance);
    const payout = newPayout(account.id, { amount, currency: body.currency ?? 'usd', method, metadata: body.metadata ?? {}, arrival_date: method === 'instant' ? now() : now() + 2 * DAY });
    later(() => emit('payout.created', account.id, payoutView(payout)));
    return payoutView(payout);
  }));

  // ── Control API (simulator only) ──

  const control = (handler) => async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (err) {
      if (err instanceof StripeFailure) return reply.status(err.status === 404 ? 404 : 409).send(err.body);
      throw err;
    }
  };
  const find = (map, key) => {
    const value = map.get(key);
    if (!value) throw missing('object', key);
    return value;
  };
  const redirectOr = (request, reply, result) =>
    request.query.redirect ? reply.redirect(String(request.query.redirect)) : result;

  app.post('/_sim/accounts/:id/complete-onboarding', control(async (request, reply) => {
    const account = find(state.accounts, request.params.id);
    Object.assign(account, { active: true, restricted: false });
    if (account.requested.cards) await emitAccount('v2.core.account[configuration.merchant].capability_status_updated', account.id);
    if (account.requested.transfers) await emitAccount('v2.core.account[configuration.recipient].capability_status_updated', account.id);
    await emitAccount('v2.core.account[requirements].updated', account.id);
    return redirectOr(request, reply, accountView(account));
  }));

  app.post('/_sim/accounts/:id/restrict', control(async (request) => {
    const account = find(state.accounts, request.params.id);
    Object.assign(account, { active: false, restricted: true });
    await emitAccount('v2.core.account[requirements].updated', account.id);
    return accountView(account);
  }));

  app.post('/_sim/accounts/:id/close', control(async (request) => {
    const account = find(state.accounts, request.params.id);
    Object.assign(account, { active: false, closed: true });
    await emitAccount('v2.core.account.closed', account.id);
    return accountView(account);
  }));

  app.post('/_sim/accounts/:id/balance', control(async (request) => {
    const account = find(state.accounts, request.params.id);
    state.balances.set(account.id, { available: int(request.body?.available, 0), instant: int(request.body?.instant, 0) });
    return state.balances.get(account.id);
  }));

  /** A seller's automatic payout; `status` paid or failed follows at once. */
  app.post('/_sim/accounts/:id/payout', control(async (request) => {
    const account = find(state.accounts, request.params.id);
    const payout = newPayout(account.id, { amount: int(request.body?.amount, 1000) });
    await emit('payout.created', account.id, payoutView(payout));
    return payoutView(payout);
  }));

  app.post('/_sim/payouts/:id/status', control(async (request) => {
    const payout = find(state.payouts, request.params.id);
    const status = request.body?.status ?? 'paid';
    Object.assign(payout, { status, failure_code: status === 'failed' ? (request.body?.failureCode ?? 'account_closed') : null });
    await emit(status === 'failed' ? 'payout.failed' : status === 'canceled' ? 'payout.canceled' : 'payout.paid', payout.account, payoutView(payout));
    return payoutView(payout);
  }));

  app.post('/_sim/next-off-session', control(async (request) => {
    state.nextOffSession = request.body?.outcome ?? 'succeeded';
    return { nextOffSession: state.nextOffSession };
  }));

  /** Pay a session: the client entered a card (and chose an amount, used a promotion code). */
  async function paySession(session, input = {}) {
    if (session.status !== 'open') throw invalid(`session is ${session.status}`);
    if (session.expires_at < now()) throw invalid('session has expired');
    const account = session.account;
    let customer = session.customer;
    const needsCustomer = session.mode !== 'payment' || session.pi?.setup_future_usage || session.customer_creation === 'always';
    if (!customer && needsCustomer) {
      customer = id('cus');
      state.customers.set(customer, { id: customer, object: 'customer', account, email: session.customer_email ?? input.email ?? 'client@example.com', name: null, metadata: {} });
      session.customer = customer;
    }

    if (session.mode === 'setup') {
      const method = newMethod(account, customer, input.card);
      session.setup_intent = { id: id('seti'), payment_method: method.id };
      Object.assign(session, { status: 'complete' });
      await emit('checkout.session.completed', account, sessionView(session));
      return session;
    }

    if (session.mode === 'subscription') {
      const sub = newSubscription(account, customer, session.items, {
        ...session.sub,
        metadata: session.sub.metadata,
      });
      session.subscription = sub.id;
      Object.assign(session, { status: 'complete', payment_status: sub.status === 'trialing' ? 'no_payment_required' : 'paid' });
      const inv = billSubscription(sub, { paid: true, reason: 'subscription_create' });
      await emit('checkout.session.completed', account, sessionView(session));
      await emit('customer.subscription.created', account, subscriptionView(sub));
      await emit('invoice.paid', account, invoiceView(inv));
      if (account === null) await emitEntitlements(customer);
      return session;
    }

    let subtotal = session.amount_subtotal;
    if (session.custom) {
      const custom = session.custom.custom_unit_amount;
      const chosen = int(input.amount, subtotal);
      if ((custom.minimum && chosen < custom.minimum) || (custom.maximum && chosen > custom.maximum)) {
        throw invalid(`The amount must be between ${custom.minimum ?? 0} and ${custom.maximum ?? '∞'}.`);
      }
      subtotal = chosen;
    }
    const discount = int(input.discount, 0);
    if (discount > 0 && !session.allow_promotion_codes) throw invalid('This page takes no promotion codes.');
    const tax = input.tax !== undefined ? int(input.tax) : session.automatic_tax ? Math.round((subtotal - discount) * 0.08) : 0;
    const total = subtotal - discount + tax;
    const method = session.pi.setup_future_usage ? newMethod(account, customer, input.card) : null;
    const pi = newIntent(account, {
      amount: total,
      currency: session.currency,
      customer,
      payment_method: method?.id ?? null,
      receipt_email: session.customer_email,
      ...session.pi,
      capture_method: session.pi.capture_method === 'manual' ? 'manual' : 'automatic',
    });
    if ((pi.application_fee_amount ?? 0) > total) throw invalid('The application fee cannot exceed the amount paid.');
    if (truthy(input.async)) {
      // A bank debit: Checkout completes unpaid while the payment is processing;
      // /_sim/payments/:pi/settle later succeeds or fails it (async_payment_* events).
      pi.status = 'processing';
      Object.assign(session, {
        status: 'complete',
        payment_status: 'unpaid',
        payment_intent: pi.id,
        amount_subtotal: subtotal,
        amount_discount: discount,
        amount_tax: tax,
        amount_total: total,
      });
      await emit('checkout.session.completed', account, sessionView(session));
      await emit('payment_intent.processing', account, intentView(pi));
      return session;
    }
    succeed(pi);
    Object.assign(session, {
      status: 'complete',
      payment_status: pi.status === 'succeeded' ? 'paid' : 'unpaid',
      payment_intent: pi.id,
      amount_subtotal: subtotal,
      amount_discount: discount,
      amount_tax: tax,
      amount_total: total,
    });
    await emit('checkout.session.completed', account, sessionView(session));
    if (pi.status === 'requires_capture') await emit('payment_intent.amount_capturable_updated', account, intentView(pi));
    return session;
  }

  app.post('/_sim/checkout/:id/pay', control(async (request, reply) => {
    const session = find(state.sessions, request.params.id);
    await paySession(session, request.body ?? {});
    return redirectOr(request, reply, sessionView(session, new Set(['payment_intent.latest_charge'])));
  }));

  app.post('/_sim/checkout/:id/expire', control(async (request) => {
    const session = find(state.sessions, request.params.id);
    session.status = 'expired';
    await emit('checkout.session.expired', session.account, sessionView(session));
    return sessionView(session);
  }));

  /** Someone pays through a payment link: a new session from the link, paid at once. */
  app.post('/_sim/links/:id/pay', control(async (request) => {
    const link = find(state.links, request.params.id);
    if (!link.active) throw invalid('This payment link is no longer active.');
    const quantity = int(request.body?.quantity, 1);
    const [item] = link.items;
    if (item.adjustable && (quantity < item.adjustable.minimum || quantity > item.adjustable.maximum)) {
      throw invalid(`Quantity must be between ${item.adjustable.minimum} and ${item.adjustable.maximum}.`);
    }
    const price = state.prices.get(item.price);
    const subtotal = unitOf(price) * quantity;
    const session = {
      id: id('cs_test'),
      secret: randomBytes(6).toString('hex'),
      account: link.account,
      mode: 'payment',
      ui_mode: 'hosted_page',
      status: 'open',
      payment_status: 'unpaid',
      currency: price.currency,
      items: [{ price: price.id, quantity }],
      custom: price.custom_unit_amount ? price : null,
      amount_subtotal: subtotal,
      amount_total: subtotal,
      amount_discount: 0,
      amount_tax: 0,
      automatic_tax: false,
      allow_promotion_codes: link.allow_promotion_codes,
      metadata: link.metadata,
      client_reference_id: null,
      customer: null,
      customer_email: request.body?.email ?? 'buyer@example.com',
      success_url: link.redirect,
      expires_at: now() + DAY,
      payment_intent: null,
      payment_link: link.id,
      pi: {
        application_fee_amount: link.application_fee_amount,
        transfer_data: link.transfer_data,
        on_behalf_of: link.on_behalf_of,
        transfer_group: link.transfer_group,
        metadata: link.pi_metadata,
        capture_method: 'automatic',
        setup_future_usage: null,
      },
    };
    state.sessions.set(session.id, session);
    await paySession(session, request.body ?? {});
    return sessionView(session, new Set(['payment_intent.latest_charge']));
  }));

  app.post('/_sim/invoices/:id/pay', control(async (request) => {
    const inv = find(state.invoices, request.params.id);
    if (inv.status !== 'open') throw invalid(`invoice is ${inv.status}`);
    payInvoice(inv);
    await emit('invoice.paid', inv.account, invoiceView(inv));
    return invoiceView(inv, new Set(['payments']));
  }));

  app.post('/_sim/invoices/:id/fail', control(async (request) => {
    const inv = find(state.invoices, request.params.id);
    if (inv.status !== 'open') throw invalid(`invoice is ${inv.status}`);
    inv.attempt_count += 1;
    await emit('invoice.payment_failed', inv.account, invoiceView(inv));
    return invoiceView(inv);
  }));

  /** The next billing period: an invoice paid (or failed, leaving the subscription past due). */
  app.post('/_sim/subscriptions/:id/renew', control(async (request) => {
    const sub = find(state.subscriptions, request.params.id);
    const paid = request.body?.paid !== false;
    if (sub.status === 'trialing') sub.status = 'active';
    sub.current_period_end += 30 * DAY;
    const inv = billSubscription(sub, { paid, reason: 'subscription_cycle' });
    if (paid && sub.status === 'past_due') sub.status = 'active';
    await emit(paid ? 'invoice.paid' : 'invoice.payment_failed', sub.account, invoiceView(inv));
    await emit('customer.subscription.updated', sub.account, subscriptionView(sub));
    return subscriptionView(sub);
  }));

  // A processing (bank debit) payment from Checkout settles: `{ status: 'succeeded' | 'failed' }`.
  app.post('/_sim/payments/:pi/settle', control(async (request) => {
    const pi = find(state.intents, request.params.pi);
    if (pi.status !== 'processing') throw invalid(`payment is ${pi.status}, not processing`);
    const session = [...state.sessions.values()].find((s) => s.payment_intent === pi.id) ?? null;
    if (request.body?.status === 'failed') {
      pi.status = 'requires_payment_method';
      pi.last_payment_error = { code: 'payment_method_failed', decline_code: null, type: 'invalid_request_error' };
      if (session) await emit('checkout.session.async_payment_failed', pi.account, sessionView(session));
      await emit('payment_intent.payment_failed', pi.account, intentView(pi));
    } else {
      succeed(pi);
      if (session) {
        session.payment_status = 'paid';
        await emit('checkout.session.async_payment_succeeded', pi.account, sessionView(session));
      }
      await emit('payment_intent.succeeded', pi.account, intentView(pi));
    }
    return intentView(pi);
  }));

  app.post('/_sim/refunds/:id/settle', control(async (request) => {
    const refund = find(state.refunds, request.params.id);
    const status = request.body?.status === 'failed' ? 'failed' : 'succeeded';
    refund.status = status;
    refund.failure_reason = status === 'failed' ? (request.body?.failureReason ?? 'expired_or_canceled_card') : null;
    const pi = state.intents.get(refund.payment_intent);
    if (status === 'succeeded' && pi) {
      pi.charge.amount_refunded += refund.amount;
      // A destination refund with reverse_transfer takes the seller's share back.
      if (refund.reverse_transfer) refund.reversed = true;
    }
    await emit(status === 'failed' ? 'refund.failed' : 'refund.updated', refund.account, refundView(refund));
    if (status === 'succeeded' && pi) {
      await emit('charge.refunded', refund.account, { ...chargeView(pi), object: 'charge' });
    }
    return refundView(refund);
  }));

  app.post('/_sim/payments/:pi/dispute', control(async (request) => {
    const pi = find(state.intents, request.params.pi);
    const dispute = {
      id: id('dp'),
      account: pi.account,
      amount: int(request.body?.amount, pi.amount_received),
      currency: pi.currency,
      status: 'needs_response',
      reason: request.body?.reason ?? 'fraudulent',
      payment_intent: pi.id,
      charge: pi.charge?.id ?? null,
      due_by: now() + 7 * DAY,
      evidence: {},
      submission_count: 0,
    };
    state.disputes.set(dispute.id, dispute);
    await emit('charge.dispute.created', dispute.account, disputeView(dispute));
    return disputeView(dispute);
  }));

  app.post('/_sim/disputes/:id/status', control(async (request) => {
    const dispute = find(state.disputes, request.params.id);
    dispute.status = request.body?.status ?? 'under_review';
    const closed = ['won', 'lost', 'warning_closed'].includes(dispute.status);
    await emit(closed ? 'charge.dispute.closed' : 'charge.dispute.updated', dispute.account, disputeView(dispute));
    return disputeView(dispute);
  }));

  app.post('/_sim/events/:id/redeliver', control(async (request) => {
    const stored = find(state.events, request.params.id);
    return { redelivered: await deliver(stored.event, stored) };
  }));

  app.get('/_sim/state', async () => ({
    accounts: [...state.accounts.values()].map((a) => accountView(a)),
    customers: [...state.customers.values()],
    sessions: [...state.sessions.values()].map((s) => ({ ...sessionView(s, new Set(['payment_intent.latest_charge'])), account: s.account })),
    intents: [...state.intents.values()].map((pi) => ({ ...intentView(pi), account: pi.account })),
    methods: [...state.methods.values()].map((m) => ({ ...methodView(m), account: m.account })),
    refunds: [...state.refunds.values()].map((r) => ({ ...refundView(r), account: r.account, reverse_transfer: r.reverse_transfer, refund_application_fee: r.refund_application_fee })),
    disputes: [...state.disputes.values()].map((d) => ({ ...disputeView(d), account: d.account })),
    products: [...state.products.values()],
    prices: [...state.prices.values()],
    features: [...state.features.values()],
    meters: [...state.meters.values()].map(meterView),
    meterEvents: state.meterEvents,
    subscriptions: [...state.subscriptions.values()].map((s) => ({ ...subscriptionView(s), account: s.account })),
    invoices: [...state.invoices.values()].map((inv) => ({ ...invoiceView(inv, new Set(['payments'])), account: inv.account, sent: inv.sent })),
    links: [...state.links.values()].map((l) => ({ ...linkView(l), account: l.account })),
    transfers: [...state.transfers.values()].map(transferView),
    payouts: [...state.payouts.values()].map((p) => ({ ...payoutView(p), account: p.account })),
    balanceSettings: Object.fromEntries([...state.balanceSettings].map(([key, s]) => [key, settingsView(s)])),
    portalSessions: state.portalSessions,
    destinations: [...state.destinations.values()].map((d) => ({ id: d.id, name: d.name, event_payload: d.event_payload, events_from: d.events_from, url: d.webhook_endpoint.url })),
  }));
  app.get('/_sim/deliveries', async () => state.deliveries);

  // ── Browser pages (manual runs) ──

  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>${title}</h1>${body}<p style="color:#666">Stripe simulator — no real money moves.</p></body>`;
  const html = (reply, title, body) => reply.type('text/html').send(page(title, body));

  app.get('/connect/onboard/:id', async (request, reply) => {
    const account = state.accounts.get(request.params.id);
    if (!account) return reply.status(404).send('unknown account');
    const ret = String(request.query.return ?? '');
    return html(reply, 'Connect with Stripe (simulated)', `<p>Account <code>${account.id}</code>, ${account.dashboard} dashboard.</p><form method="post" action="/_sim/accounts/${account.id}/complete-onboarding?redirect=${encodeURIComponent(ret)}"><button>Finish onboarding</button></form>`);
  });

  app.get('/pay/:id', async (request, reply) => {
    const session = state.sessions.get(request.params.id);
    if (!session) return reply.status(404).send('unknown session');
    const amount = (session.amount_total / 100).toFixed(2);
    const title = session.mode === 'setup' ? 'Save a card' : `Pay ${amount} ${String(session.currency).toUpperCase()}`;
    const action = `/_sim/checkout/${session.id}/pay?redirect=${encodeURIComponent(session.success_url ?? '/')}`;
    const bankDebit =
      session.mode === 'payment'
        ? `<form method="post" action="${action}"><input type="hidden" name="async" value="true"><button>Pay by bank debit (settles later)</button></form>`
        : '';
    return html(reply, title, `<form method="post" action="${action}"><button>${session.mode === 'setup' ? 'Save' : 'Pay with'} 4242 4242 4242 4242</button></form>${bankDebit}`);
  });

  app.get('/buy/:id', async (request, reply) => {
    const link = state.links.get(request.params.id);
    if (!link) return reply.status(404).send('unknown link');
    return html(reply, 'Payment link', `<form method="post" action="/_sim/links/${link.id}/pay"><button>Pay</button></form>`);
  });

  app.get('/invoice/:id', async (request, reply) => {
    const inv = state.invoices.get(request.params.id);
    if (!inv) return reply.status(404).send('unknown invoice');
    return html(reply, `Invoice ${inv.number ?? inv.id}`, `<p>${(inv.subtotal / 100).toFixed(2)} ${inv.currency.toUpperCase()} — ${inv.status}</p><form method="post" action="/_sim/invoices/${inv.id}/pay"><button>Pay invoice</button></form>`);
  });

  app.get('/portal/:id', async (_request, reply) => html(reply, 'Customer portal (simulated)', '<p>Update cards, see invoices, cancel.</p>'));

  app.get('/express/:id', async (request, reply) => html(reply, 'Express dashboard (simulated)', `<p>Account <code>${request.params.id}</code>.</p>`));

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        type: 'invalid_request_error',
        message: `The Stripe simulator does not implement ${request.method} ${request.url.split('?')[0]} yet. Add it to examples/payments-connect-app/stripe-sim/server.mjs.`,
      },
    }),
  );

  return { app, state };
}
