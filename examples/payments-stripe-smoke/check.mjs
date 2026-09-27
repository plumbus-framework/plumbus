// Smoke check for @plumbus/payments + @plumbus/payments-stripe.
//
//   node check.mjs                      # offline battery (no keys, no network)
//   STRIPE_SECRET_KEY=sk_test_… node check.mjs   # + live Stripe test-mode battery
//
// Offline: the real webhook route on Fastify, Stripe-signed events over HTTP,
// Stripe's API stubbed in-process. Live: talks to Stripe in TEST mode only
// (refuses live keys) — creates a v2 seller account and an onboarding link,
// runs doctor, and, with STRIPE_SMOKE_SELLER=acct_… (an onboarded test seller),
// creates a real Checkout session you can pay with 4242 4242 4242 4242.
import { buildApp, paymentsConfig, SELLER } from './lib/app.mjs';
import {
  createPayments,
  createStripeHttpStub,
  signStripeWebhook,
  STRIPE_API_VERSION,
  stripeProvider,
  stripeSnapshotEvent,
  stripeThinAccountEvent,
} from './lib/deps.mjs';

const results = [];
function record(name, status, detail = '') {
  results.push({ name, status });
  const badge = { PASS: '  PASS  ', FAIL: '  FAIL  ', SKIP: '  SKIP  ', INFO: '  INFO  ' }[status];
  console.log(`[${badge}] ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    record(name, 'PASS', (await fn()) || '');
  } catch (err) {
    record(name, 'FAIL', err.message);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const SNAPSHOT_SECRET = 'whsec_smoke_snapshot';
const THIN_SECRET = 'whsec_smoke_thin';

async function offline() {
  console.log('\nOffline battery (Stripe API stubbed)\n' + '-'.repeat(36));
  let onboarded = false;
  let paid = false;
  let reference = '';
  const stub = createStripeHttpStub()
    .on('POST /v2/core/accounts', () => account(false))
    .on('GET /v2/core/accounts/*', () => account(onboarded))
    .on('POST /v2/core/account_links', () => ({
      object: 'v2.core.account_link',
      account: 'acct_smoke',
      url: 'https://connect.stripe.com/setup/e/acct_smoke/x',
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      created: new Date().toISOString(),
      livemode: false,
      use_case: { type: 'account_onboarding' },
    }))
    .on('POST /v1/checkout/sessions', (req) => {
      reference = req.body.client_reference_id;
      return session(false);
    })
    .on('GET /v1/checkout/sessions/*', () => session(paid));

  function account(active) {
    const status = active ? 'active' : 'pending';
    return {
      id: 'acct_smoke',
      object: 'v2.core.account',
      livemode: false,
      dashboard: 'full',
      identity: { country: 'US' },
      defaults: { currency: 'usd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      configuration: {
        merchant: {
          applied: true,
          capabilities: {
            card_payments: { status, status_details: [] },
            stripe_balance: { payouts: { status, status_details: [] } },
          },
        },
      },
      requirements: { entries: active ? [] : [{ description: 'Provide a bank account', awaiting_action_from: 'user', minimum_deadline: { status: 'currently_due' } }] },
    };
  }
  function session(isPaid) {
    return {
      id: 'cs_smoke',
      object: 'checkout.session',
      status: isPaid ? 'complete' : 'open',
      payment_status: isPaid ? 'paid' : 'unpaid',
      url: isPaid ? null : 'https://checkout.stripe.com/c/pay/cs_smoke',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      amount_total: 2500,
      currency: 'usd',
      livemode: false,
      client_reference_id: reference,
      payment_intent: isPaid
        ? { id: 'pi_smoke', status: 'succeeded', application_fee_amount: 125, latest_charge: { id: 'ch_smoke', amount_refunded: 0, created: Math.floor(Date.now() / 1000) } }
        : null,
    };
  }

  const provider = stripeProvider({
    secretKey: 'sk_test_smoke',
    webhookSecrets: [SNAPSHOT_SECRET, THIN_SECRET],
    httpClient: stub.httpClient,
    maxNetworkRetries: 0,
  });
  const env = await buildApp({ provider });
  const post = (delivery) =>
    env.app.inject({ method: 'POST', url: '/payments/webhooks/stripe', headers: delivery.headers, payload: delivery.rawBody });

  await check('Stripe rule: Express with Stripe-covered losses is refused', () => {
    try {
      createPayments(paymentsConfig(provider, 'http://x.test', { dashboards: { express: { losses: 'provider' } } }));
    } catch (err) {
      assert(/Express-dashboard sellers/.test(err.message), err.message);
      return 'rejected at startup';
    }
    throw new Error('config was accepted');
  });

  await check('Seller onboarding returns a Stripe onboarding link', async () => {
    const result = await env.run('startMerchantOnboarding', {});
    assert(result.onboardingUrl.startsWith('https://connect.stripe.com/'), result.onboardingUrl);
    assert(result.merchantAccount.status === 'onboarding', result.merchantAccount.status);
    return result.merchantAccount.id;
  });

  await check('Signed thin account event over HTTP activates the seller', async () => {
    onboarded = true;
    const delivery = signStripeWebhook({
      payload: stripeThinAccountEvent({ type: 'v2.core.account[configuration.merchant].capability_status_updated', accountId: 'acct_smoke' }),
      secret: THIN_SECRET,
    });
    const response = await post(delivery);
    assert(response.statusCode === 200, `HTTP ${response.statusCode}`);
    await env.settle();
    const { merchantAccount } = await env.run('getMerchantAccount', {});
    assert(merchantAccount.status === 'active', merchantAccount.status);
    return 'status active';
  });

  let chargeId = '';
  await check('createCharge computes the 5% cut on the seller account', async () => {
    const { charge } = await env.run('createCharge', { amount: 2500, currency: 'usd', description: 'Smoke lesson' });
    chargeId = charge.id;
    const request = stub.requests.find((r) => r.path === '/v1/checkout/sessions');
    assert(request.headers['stripe-account'] === 'acct_smoke', 'missing Stripe-Account');
    assert(request.body['payment_intent_data[application_fee_amount]'] === '125', 'fee not 125');
    return `link ${charge.url}`;
  });

  await check('Signed checkout.session.completed marks the charge paid once', async () => {
    paid = true;
    const delivery = signStripeWebhook({
      payload: stripeSnapshotEvent({
        id: 'evt_smoke_paid',
        type: 'checkout.session.completed',
        account: 'acct_smoke',
        object: { id: 'cs_smoke', object: 'checkout.session' },
      }),
      secret: SNAPSHOT_SECRET,
    });
    assert((await post(delivery)).statusCode === 200, 'first delivery failed');
    assert((await post(delivery)).statusCode === 200, 'second delivery failed');
    await env.settle();
    const { charge } = await env.run('getCharge', { chargeId });
    assert(charge.status === 'paid', charge.status);
    const paidEvents = env.emitted('payments.charge.paid');
    assert(paidEvents.length === 1, `${paidEvents.length} paid events`);
    return 'payments.charge.paid ×1';
  });

  await check('Forged signature is rejected with 400', async () => {
    const response = await env.app.inject({
      method: 'POST',
      url: '/payments/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=forged' },
      payload: '{"id":"evt_x","object":"event"}',
    });
    assert(response.statusCode === 400, `HTTP ${response.statusCode}`);
  });
  await env.app.close();
}

async function live() {
  console.log('\nLive battery (Stripe test mode)\n' + '-'.repeat(31));
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    record('Live Stripe checks', 'SKIP', 'set STRIPE_SECRET_KEY=sk_test_… to run');
    return;
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    record('Live Stripe checks', 'FAIL', 'refusing to run with a non-test key');
    return;
  }
  const provider = stripeProvider({ secretKey: key, webhookSecrets: ['whsec_unused'] });
  const payments = createPayments(paymentsConfig(provider, 'https://example.com'));
  record('SDK API version', 'INFO', STRIPE_API_VERSION);

  await check('doctor --live', async () => {
    const findings = await payments.diagnose({ live: true });
    for (const f of findings) console.log(`           ${f.level} [${f.code}] ${f.message}`);
    const connect = findings.find((f) => f.code === 'stripe_accounts_v2_unavailable');
    assert(!connect, connect?.message);
    return `${findings.length} findings`;
  });

  let accountId = '';
  await check('Create a v2 seller account (full dashboard, US)', async () => {
    const account = await provider.createMerchantAccount({
      dashboard: 'full',
      feesCollector: 'provider',
      lossesCollector: 'provider',
      country: 'US',
      email: `smoke+${Date.now()}@example.com`,
      metadata: { plumbus_smoke: 'true' },
      idempotencyKey: `plumbus-smoke-${Date.now()}`,
    });
    accountId = account.id;
    return `${account.id} (charges enabled: ${account.chargesEnabled})`;
  });

  if (accountId) {
    await check('Create a v2 onboarding link', async () => {
      const link = await provider.createOnboardingLink({
        accountId,
        returnUrl: 'https://example.com/return',
        refreshUrl: 'https://example.com/refresh',
        collectEventuallyDue: false,
      });
      return link.url;
    });
  }

  const seller = process.env.STRIPE_SMOKE_SELLER;
  if (!seller) {
    record('Checkout on an onboarded seller', 'SKIP', 'set STRIPE_SMOKE_SELLER=acct_… (onboarded test seller)');
    return;
  }
  await check('Create a Checkout session with a platform fee', async () => {
    const charge = await provider.createCharge({
      accountId: seller,
      reference: `smoke-${Date.now()}`,
      amount: 2500,
      currency: 'usd',
      description: 'Plumbus smoke charge',
      platformFeeAmount: 125,
      successUrl: 'https://example.com/paid',
      cancelUrl: 'https://example.com/cancel',
      expiresAt: new Date(Date.now() + 60 * 60_000),
      metadata: { plumbus_smoke: 'true' },
      idempotencyKey: `plumbus-smoke-charge-${Date.now()}`,
    });
    return `pay with 4242 4242 4242 4242: ${charge.url}`;
  });
}

console.log('\n@plumbus/payments-stripe — smoke check\n' + '='.repeat(38));
console.log(`demo seller  ${SELLER.userId} @ ${SELLER.tenantId}`);
await offline();
await live();
const failed = results.filter((r) => r.status === 'FAIL');
console.log(`\n${results.length - failed.length}/${results.length} passed or skipped`);
process.exitCode = failed.length ? 1 : 0;
