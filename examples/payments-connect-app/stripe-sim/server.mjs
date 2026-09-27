// Local Stripe simulator for the payments test app.
//
// A stateful stand-in for the parts of Stripe's API that @plumbus/payments-stripe
// calls, on API version 2026-08-26.dahlia:
//   v2: accounts, account_links, event_destinations
//   v1: account_sessions, accounts/:id/login_links, customers, checkout/sessions,
//       refunds, disputes
// It enforces Stripe's Connect rules (Express needs platform fees + losses,
// platform losses need platform fees, direct charges need an active seller,
// Checkout minimum amount), honours Idempotency-Key, and delivers signed
// webhooks — snapshot events from sellers' accounts and thin v2 account events —
// to the event destinations created through the API (`plumbus payments
// webhooks setup`).
//
// Control endpoints under /_sim move objects through their lifecycle (finish
// onboarding, pay, refund, dispute, redeliver). Browser pages under /connect,
// /pay, and /express let a human click through the same steps.
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

function stripeError(reply, status, type, message, extra = {}) {
  return reply.status(status).send({ error: { type, message, ...extra } });
}

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

function queryArray(query, name) {
  return Object.entries(query)
    .filter(([key]) => key === name || key.startsWith(`${name}[`))
    .map(([, value]) => value);
}

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
    refunds: new Map(),
    disputes: new Map(),
    destinations: new Map(),
    events: new Map(),
    deliveries: [],
    idempotency: new Map(),
  };
  let counter = 0;
  const id = (prefix) => `${prefix}_sim_${(++counter).toString().padStart(6, '0')}`;
  const now = () => Math.floor(Date.now() / 1000);

  const app = Fastify({ logger: false });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, parseForm(body)),
  );

  // Every Stripe API call needs a Bearer key; the simulator accepts any test key.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1/') && !request.url.startsWith('/v2/')) return;
    const auth = request.headers.authorization ?? '';
    if (!/^Bearer (sk|rk)_test_/.test(auth)) {
      return stripeError(reply, 401, 'invalid_request_error', 'Invalid API Key provided (simulator accepts test keys only)');
    }
  });

  // Idempotency: same key + same body → same response; different body → 400.
  function idempotent(request, reply, create) {
    const key = request.headers['idempotency-key'];
    if (!key) return create();
    const scope = `${request.headers['stripe-account'] ?? 'platform'}:${request.routeOptions.url}:${key}`;
    const fingerprint = JSON.stringify(request.body ?? {});
    const hit = state.idempotency.get(scope);
    if (hit) {
      if (hit.fingerprint !== fingerprint) {
        return stripeError(reply, 400, 'idempotency_error', 'Keys for idempotent requests can only be used with the same parameters they were first used with.');
      }
      return hit.response;
    }
    const response = create();
    if (response && !response.error && reply.statusCode < 400) {
      state.idempotency.set(scope, { fingerprint, response });
    }
    return response;
  }

  function sellerOf(request, reply) {
    const accountId = request.headers['stripe-account'];
    const account = accountId ? state.accounts.get(accountId) : null;
    if (!account) {
      stripeError(reply, 400, 'invalid_request_error', 'This call needs the Stripe-Account header of a connected account (direct charges).');
      return null;
    }
    return account;
  }

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

  function snapshotEvent(type, accountId, object) {
    return {
      id: id('evt'),
      object: 'event',
      api_version: API_VERSION,
      created: now(),
      livemode: false,
      account: accountId,
      type,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: { object },
    };
  }

  function thinAccountEvent(type, accountId) {
    return {
      id: id('evt'),
      object: 'v2.core.event',
      type,
      livemode: false,
      created: new Date().toISOString(),
      context: null,
      reason: null,
      related_object: { id: accountId, type: 'v2.core.account', url: `/v2/core/accounts/${accountId}` },
    };
  }

  const emitAccount = (type, accountId) =>
    deliver(thinAccountEvent(type, accountId), { format: 'thin', accountScoped: false });
  const emitSnapshot = (type, accountId, object) =>
    deliver(snapshotEvent(type, accountId, object), { format: 'snapshot', accountScoped: true });

  // ── Views ──

  function accountView(a) {
    const status = a.closed ? 'restricted' : a.active ? 'active' : a.restricted ? 'restricted' : 'pending';
    const details = a.restricted ? [{ code: 'requirements_past_due', resolution: 'provide_info' }] : [];
    return {
      id: a.id,
      object: 'v2.core.account',
      applied_configurations: ['merchant'],
      closed: a.closed,
      created: a.created,
      livemode: false,
      dashboard: a.dashboard,
      contact_email: a.contact_email ?? null,
      display_name: a.display_name ?? null,
      identity: { country: a.country.toUpperCase(), entity_type: 'individual' },
      defaults: {
        currency: a.currency,
        responsibilities: {
          fees_collector: a.fees_collector,
          losses_collector: a.losses_collector,
          requirements_collector: a.losses_collector === 'application' && a.dashboard === 'none' ? 'application' : 'stripe',
        },
      },
      configuration: {
        merchant: {
          applied: true,
          capabilities: {
            card_payments: { status, status_details: details },
            stripe_balance: { payouts: { status, status_details: details } },
          },
        },
      },
      requirements: {
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
      },
      metadata: a.metadata,
    };
  }

  function intentView(pi) {
    if (!pi) return null;
    return {
      id: pi.id,
      object: 'payment_intent',
      status: pi.status,
      amount: pi.amount,
      currency: pi.currency,
      application_fee_amount: pi.application_fee_amount,
      metadata: pi.metadata,
      latest_charge: { id: pi.charge_id, object: 'charge', amount_refunded: pi.amount_refunded, created: pi.created },
    };
  }

  function sessionView(s, expandIntent) {
    const pi = s.payment_intent ? state.intents.get(s.payment_intent) : null;
    return {
      id: s.id,
      object: 'checkout.session',
      mode: 'payment',
      status: s.status,
      payment_status: s.payment_status,
      url: s.status === 'open' ? `${baseUrl}/pay/${s.id}` : null,
      expires_at: s.expires_at,
      amount_total: s.amount,
      currency: s.currency,
      livemode: false,
      client_reference_id: s.client_reference_id ?? null,
      metadata: s.metadata,
      customer: s.customer ?? null,
      customer_email: s.customer_email ?? null,
      customer_details: s.payment_status === 'paid' ? { email: s.customer_email ?? 'client@example.com' } : null,
      payment_intent: pi ? (expandIntent ? intentView(pi) : pi.id) : null,
      success_url: s.success_url,
      cancel_url: s.cancel_url,
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
    evidence_details: { due_by: d.due_by },
  });

  const list = (data, url) => ({ object: 'list', data, has_more: false, url });

  // ── v2 accounts ──

  app.post('/v2/core/accounts', async (request, reply) =>
    idempotent(request, reply, () => {
      const body = request.body ?? {};
      const dashboard = body.dashboard ?? 'full';
      const fees = body.defaults?.responsibilities?.fees_collector ?? 'stripe';
      const losses = body.defaults?.responsibilities?.losses_collector ?? 'stripe';
      if (dashboard === 'express' && (fees !== 'application' || losses !== 'application')) {
        return stripeError(reply, 400, 'invalid_request_error', 'If `dashboard` is `express`, `fees_collector` must be `application` and `losses_collector` must be `application`.', { code: 'account_controller_express_dash_without_application_losses_or_fees' });
      }
      if (losses === 'application' && fees !== 'application') {
        return stripeError(reply, 400, 'invalid_request_error', 'If `losses_collector` is `application`, `fees_collector` must also be `application`.', { code: 'account_controller_stripe_pricing_platform_liable' });
      }
      if (!body.identity?.country) {
        return stripeError(reply, 400, 'invalid_request_error', 'The `identity.country` value is required but not provided.', { code: 'identity_country_required' });
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
        active: false,
        restricted: false,
        closed: false,
      };
      state.accounts.set(account.id, account);
      queueMicrotask(() => void emitAccount('v2.core.account.created', account.id));
      return accountView(account);
    }),
  );

  app.get('/v2/core/accounts/:id', async (request, reply) => {
    const account = state.accounts.get(request.params.id);
    if (!account) return stripeError(reply, 404, 'invalid_request_error', `No such account: '${request.params.id}'`, { code: 'resource_missing' });
    return accountView(account);
  });

  app.get('/v2/core/accounts', async () => ({
    data: [...state.accounts.values()].map(accountView),
    next_page_url: null,
    previous_page_url: null,
  }));

  app.post('/v2/core/account_links', async (request, reply) => {
    const body = request.body ?? {};
    const account = state.accounts.get(body.account);
    if (!account) return stripeError(reply, 404, 'invalid_request_error', `No such account: '${body.account}'`);
    const useCase = body.use_case?.account_onboarding ?? body.use_case?.account_update ?? {};
    const returnUrl = useCase.return_url ?? '';
    return {
      object: 'v2.core.account_link',
      account: account.id,
      created: new Date().toISOString(),
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      livemode: false,
      url: `${baseUrl}/connect/onboard/${account.id}?return=${encodeURIComponent(returnUrl)}`,
      use_case: body.use_case,
    };
  });

  // ── v2 event destinations ──

  app.get('/v2/core/event_destinations', async () => ({
    data: [...state.destinations.values()].map(({ webhook_endpoint, ...d }) => ({
      ...d,
      webhook_endpoint: { url: webhook_endpoint.url, signing_secret: null },
    })),
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
    const include = Array.isArray(body.include) ? body.include : [];
    return {
      ...destination,
      webhook_endpoint: {
        url: destination.webhook_endpoint.url,
        signing_secret: include.includes('webhook_endpoint.signing_secret')
          ? destination.webhook_endpoint.signing_secret
          : null,
      },
    };
  });

  // ── v1 connected-account helpers ──

  app.post('/v1/account_sessions', async (request, reply) => {
    const account = state.accounts.get(request.body?.account);
    if (!account) return stripeError(reply, 404, 'invalid_request_error', 'No such account');
    return {
      object: 'account_session',
      account: account.id,
      client_secret: `accs_sim_secret_${randomBytes(8).toString('hex')}`,
      expires_at: now() + 1800,
      livemode: false,
      components: request.body?.components ?? {},
    };
  });

  app.post('/v1/accounts/:id/login_links', async (request, reply) => {
    const account = state.accounts.get(request.params.id);
    if (!account) return stripeError(reply, 404, 'invalid_request_error', 'No such account');
    if (account.dashboard !== 'express') {
      return stripeError(reply, 400, 'invalid_request_error', 'Login links are only available for Express-dashboard accounts.');
    }
    return { object: 'login_link', created: now(), url: `${baseUrl}/express/${account.id}` };
  });

  app.post('/v1/customers', async (request, reply) =>
    idempotent(request, reply, () => {
      const seller = sellerOf(request, reply);
      if (!seller) return undefined;
      const customer = { id: id('cus'), object: 'customer', email: request.body?.email ?? null, name: request.body?.name ?? null, metadata: request.body?.metadata ?? {}, account: seller.id };
      state.customers.set(customer.id, customer);
      return customer;
    }),
  );

  // ── v1 Checkout (direct charges) ──

  app.post('/v1/checkout/sessions', async (request, reply) =>
    idempotent(request, reply, () => {
      const seller = sellerOf(request, reply);
      if (!seller) return undefined;
      if (!seller.active) {
        return stripeError(reply, 400, 'invalid_request_error', 'Your destination account needs to have at least one of the following capabilities enabled: card_payments.', { code: 'account_invalid' });
      }
      const body = request.body ?? {};
      const line = body.line_items?.[0]?.price_data ?? {};
      const amount = Number(line.unit_amount ?? 0);
      const currency = line.currency ?? 'usd';
      if (amount < (MIN_AMOUNT[currency] ?? 50)) {
        return stripeError(reply, 400, 'invalid_request_error', `The Checkout Session's total amount due must add up to at least ${MIN_AMOUNT[currency] ?? 50} ${currency}`, { code: 'amount_too_small', param: 'line_items[0][price_data][unit_amount]' });
      }
      const fee = Number(body.payment_intent_data?.application_fee_amount ?? 0);
      if (fee > amount) {
        return stripeError(reply, 400, 'invalid_request_error', 'The application fee cannot exceed the amount.', { param: 'payment_intent_data[application_fee_amount]' });
      }
      const session = {
        id: id('cs_test'),
        account: seller.id,
        status: 'open',
        payment_status: 'unpaid',
        amount,
        currency,
        description: line.product_data?.name ?? '',
        application_fee_amount: fee,
        pi_metadata: body.payment_intent_data?.metadata ?? {},
        metadata: body.metadata ?? {},
        client_reference_id: body.client_reference_id,
        customer: body.customer,
        customer_email: body.customer_email ?? (body.customer ? state.customers.get(body.customer)?.email : null),
        success_url: body.success_url,
        cancel_url: body.cancel_url,
        expires_at: Number(body.expires_at ?? now() + 86_400),
        payment_intent: null,
      };
      state.sessions.set(session.id, session);
      return sessionView(session, false);
    }),
  );

  app.get('/v1/checkout/sessions/:id', async (request, reply) => {
    const session = state.sessions.get(request.params.id);
    if (!session || session.account !== request.headers['stripe-account']) {
      return stripeError(reply, 404, 'invalid_request_error', `No such checkout.session: '${request.params.id}'`, { code: 'resource_missing' });
    }
    return sessionView(session, queryArray(request.query, 'expand').includes('payment_intent.latest_charge'));
  });

  app.get('/v1/checkout/sessions', async (request) => {
    const accountId = request.headers['stripe-account'];
    const pi = request.query.payment_intent;
    const expand = queryArray(request.query, 'expand').includes('data.payment_intent.latest_charge');
    const data = [...state.sessions.values()]
      .filter((s) => s.account === accountId && (!pi || s.payment_intent === pi))
      .map((s) => sessionView(s, expand));
    return list(data, '/v1/checkout/sessions');
  });

  // ── v1 refunds and disputes ──

  app.post('/v1/refunds', async (request, reply) =>
    idempotent(request, reply, () => {
      const seller = sellerOf(request, reply);
      if (!seller) return undefined;
      const pi = state.intents.get(request.body?.payment_intent);
      if (!pi || pi.account !== seller.id) {
        return stripeError(reply, 404, 'invalid_request_error', 'No such payment_intent', { code: 'resource_missing' });
      }
      const pending = [...state.refunds.values()]
        .filter((r) => r.payment_intent === pi.id && r.status === 'pending')
        .reduce((sum, r) => sum + r.amount, 0);
      const remaining = pi.amount - pi.amount_refunded - pending;
      const amount = request.body?.amount ? Number(request.body.amount) : remaining;
      if (amount <= 0 || amount > remaining) {
        return stripeError(reply, 400, 'invalid_request_error', `Refund amount (${amount}) is greater than unrefunded amount on charge (${remaining})`, { code: 'amount_too_large' });
      }
      const refund = {
        id: id('re'),
        account: seller.id,
        amount,
        currency: pi.currency,
        status: 'pending',
        reason: request.body?.reason ?? null,
        failure_reason: null,
        metadata: request.body?.metadata ?? {},
        payment_intent: pi.id,
        charge: pi.charge_id,
        refund_application_fee: request.body?.refund_application_fee === 'true',
      };
      state.refunds.set(refund.id, refund);
      queueMicrotask(() => void emitSnapshot('refund.created', seller.id, refundView(refund)));
      return refundView(refund);
    }),
  );

  app.get('/v1/refunds/:id', async (request, reply) => {
    const refund = state.refunds.get(request.params.id);
    if (!refund || refund.account !== request.headers['stripe-account']) return stripeError(reply, 404, 'invalid_request_error', 'No such refund');
    return refundView(refund);
  });

  app.get('/v1/refunds', async (request) => {
    const accountId = request.headers['stripe-account'];
    const data = [...state.refunds.values()]
      .filter((r) => r.account === accountId && (!request.query.charge || r.charge === request.query.charge))
      .map(refundView);
    return list(data, '/v1/refunds');
  });

  app.get('/v1/disputes/:id', async (request, reply) => {
    const dispute = state.disputes.get(request.params.id);
    if (!dispute || dispute.account !== request.headers['stripe-account']) return stripeError(reply, 404, 'invalid_request_error', 'No such dispute');
    return disputeView(dispute);
  });

  // ── Control API (simulator only) ──

  const must = (map, key, reply) => {
    const value = map.get(key);
    if (!value) reply.status(404).send({ error: { message: `unknown ${key}` } });
    return value;
  };
  const redirectOr = (request, reply, result) =>
    request.query.redirect ? reply.redirect(String(request.query.redirect)) : result;

  app.post('/_sim/accounts/:id/complete-onboarding', async (request, reply) => {
    const account = must(state.accounts, request.params.id, reply);
    if (!account) return;
    Object.assign(account, { active: true, restricted: false });
    await emitAccount('v2.core.account[configuration.merchant].capability_status_updated', account.id);
    await emitAccount('v2.core.account[requirements].updated', account.id);
    return redirectOr(request, reply, accountView(account));
  });

  app.post('/_sim/accounts/:id/restrict', async (request, reply) => {
    const account = must(state.accounts, request.params.id, reply);
    if (!account) return;
    Object.assign(account, { active: false, restricted: true });
    await emitAccount('v2.core.account[requirements].updated', account.id);
    return accountView(account);
  });

  app.post('/_sim/accounts/:id/close', async (request, reply) => {
    const account = must(state.accounts, request.params.id, reply);
    if (!account) return;
    Object.assign(account, { active: false, closed: true });
    await emitAccount('v2.core.account.closed', account.id);
    return accountView(account);
  });

  app.post('/_sim/checkout/:id/pay', async (request, reply) => {
    const session = must(state.sessions, request.params.id, reply);
    if (!session) return;
    if (session.status !== 'open') return reply.status(409).send({ error: { message: `session is ${session.status}` } });
    const pi = {
      id: id('pi'),
      account: session.account,
      status: 'succeeded',
      amount: session.amount,
      currency: session.currency,
      application_fee_amount: session.application_fee_amount || null,
      metadata: session.pi_metadata,
      charge_id: id('ch'),
      amount_refunded: 0,
      created: now(),
    };
    state.intents.set(pi.id, pi);
    Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: pi.id });
    await emitSnapshot('checkout.session.completed', session.account, sessionView(session, false));
    return redirectOr(request, reply, sessionView(session, true));
  });

  app.post('/_sim/checkout/:id/expire', async (request, reply) => {
    const session = must(state.sessions, request.params.id, reply);
    if (!session) return;
    session.status = 'expired';
    await emitSnapshot('checkout.session.expired', session.account, sessionView(session, false));
    return sessionView(session, false);
  });

  app.post('/_sim/refunds/:id/settle', async (request, reply) => {
    const refund = must(state.refunds, request.params.id, reply);
    if (!refund) return;
    const status = request.body?.status === 'failed' ? 'failed' : 'succeeded';
    refund.status = status;
    refund.failure_reason = status === 'failed' ? (request.body?.failureReason ?? 'expired_or_canceled_card') : null;
    const pi = state.intents.get(refund.payment_intent);
    if (status === 'succeeded' && pi) pi.amount_refunded += refund.amount;
    await emitSnapshot(status === 'failed' ? 'refund.failed' : 'refund.updated', refund.account, refundView(refund));
    return refundView(refund);
  });

  app.post('/_sim/payments/:pi/dispute', async (request, reply) => {
    const pi = must(state.intents, request.params.pi, reply);
    if (!pi) return;
    const dispute = {
      id: id('dp'),
      account: pi.account,
      amount: Number(request.body?.amount ?? pi.amount),
      currency: pi.currency,
      status: 'needs_response',
      reason: request.body?.reason ?? 'fraudulent',
      payment_intent: pi.id,
      due_by: now() + 7 * 86_400,
    };
    state.disputes.set(dispute.id, dispute);
    await emitSnapshot('charge.dispute.created', dispute.account, disputeView(dispute));
    return disputeView(dispute);
  });

  app.post('/_sim/disputes/:id/status', async (request, reply) => {
    const dispute = must(state.disputes, request.params.id, reply);
    if (!dispute) return;
    dispute.status = request.body?.status ?? 'under_review';
    const closed = ['won', 'lost', 'warning_closed'].includes(dispute.status);
    await emitSnapshot(closed ? 'charge.dispute.closed' : 'charge.dispute.updated', dispute.account, disputeView(dispute));
    return disputeView(dispute);
  });

  app.post('/_sim/events/:id/redeliver', async (request, reply) => {
    const stored = must(state.events, request.params.id, reply);
    if (!stored) return;
    const delivered = await deliver(stored.event, stored);
    return { redelivered: delivered };
  });

  app.get('/_sim/state', async () => ({
    accounts: [...state.accounts.values()].map(accountView),
    sessions: [...state.sessions.values()].map((s) => sessionView(s, true)),
    refunds: [...state.refunds.values()].map(refundView),
    disputes: [...state.disputes.values()].map(disputeView),
    destinations: [...state.destinations.values()].map((d) => ({ name: d.name, event_payload: d.event_payload, url: d.webhook_endpoint.url })),
  }));
  app.get('/_sim/deliveries', async () => state.deliveries);

  // ── Browser pages (manual runs) ──

  const page = (title, body) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:3rem auto"><h1>${title}</h1>${body}<p style="color:#666">Stripe simulator — no real money moves.</p></body>`;

  app.get('/connect/onboard/:id', async (request, reply) => {
    const account = state.accounts.get(request.params.id);
    if (!account) return reply.status(404).send('unknown account');
    const ret = String(request.query.return ?? '');
    reply.type('text/html');
    return page('Connect with Stripe (simulated)', `<p>Account <code>${account.id}</code>, ${account.dashboard} dashboard.</p><form method="post" action="/_sim/accounts/${account.id}/complete-onboarding?redirect=${encodeURIComponent(ret)}"><button>Finish onboarding</button></form>`);
  });

  app.get('/pay/:id', async (request, reply) => {
    const session = state.sessions.get(request.params.id);
    if (!session) return reply.status(404).send('unknown session');
    reply.type('text/html');
    const amount = (session.amount / 100).toFixed(2);
    return page(`Pay ${amount} ${session.currency.toUpperCase()}`, `<p>${session.description}</p><form method="post" action="/_sim/checkout/${session.id}/pay?redirect=${encodeURIComponent(session.success_url ?? '/')}"><button>Pay with 4242 4242 4242 4242</button></form>`);
  });

  app.get('/express/:id', async (request, reply) => {
    reply.type('text/html');
    return page('Express dashboard (simulated)', `<p>Account <code>${request.params.id}</code>.</p>`);
  });

  app.setNotFoundHandler((request, reply) =>
    stripeError(reply, 404, 'invalid_request_error', `The Stripe simulator does not implement ${request.method} ${request.url.split('?')[0]} yet. Add it to examples/payments-connect-app/stripe-sim/server.mjs.`),
  );

  return { app, state };
}
