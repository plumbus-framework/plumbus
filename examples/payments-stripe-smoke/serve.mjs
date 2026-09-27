// Interactive Stripe TEST-mode walk-through for @plumbus/payments-stripe.
//
//   STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRETS=whsec_… node serve.mjs
//
// In another terminal forward Stripe events (see README.md for the exact
// `stripe listen` command). Then:
//   curl -X POST localhost:3000/seller/onboard        → open onboardingUrl, use Stripe test data
//   open http://localhost:3000/seller/return           → pulls fresh status (or wait for the webhook)
//   curl -X POST localhost:3000/charges -H 'content-type: application/json' \
//        -d '{"amount":2500,"currency":"usd","description":"Test lesson"}'   → pay url with 4242…
//   curl localhost:3000/charges                        → status becomes "paid" after the webhook
//   curl -X POST localhost:3000/charges/<id>/refund -H 'content-type: application/json' -d '{}'
import { buildApp } from './lib/app.mjs';
import { stripeProvider } from './lib/deps.mjs';

const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('Set STRIPE_SECRET_KEY to a Stripe TEST key (sk_test_… or rk_test_…). Live keys are refused.');
  process.exit(1);
}
const secrets = (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean);
if (secrets.length === 0) {
  console.error('Set STRIPE_WEBHOOK_SECRETS to the whsec_… printed by `stripe listen`.');
  process.exit(1);
}
const port = Number(process.env.PORT ?? 3000);
const baseUrl = `http://localhost:${port}`;

const env = await buildApp({
  provider: stripeProvider({ secretKey: key, webhookSecrets: secrets }),
  baseUrl,
  log: (line) => console.log(`[payments] ${line}`),
});
const { app, run } = env;

const safe = (handler) => async (request, reply) => {
  try {
    return await handler(request, reply);
  } catch (err) {
    reply.status(err.code === 'notFound' ? 404 : err.code === 'forbidden' ? 403 : 400);
    return { error: { code: err.code ?? 'error', message: err.message, metadata: err.metadata } };
  }
};

app.get('/', async () => ({
  seller: (await run('getMerchantAccount', {})).merchantAccount,
  webhook: `${baseUrl}/payments/webhooks/stripe`,
}));
app.get('/seller', safe(async () => run('getMerchantAccount', {})));
app.post('/seller/onboard', safe(async () => run('startMerchantOnboarding', {})));
app.get(
  '/seller/refresh',
  safe(async (_request, reply) => {
    const { onboardingUrl } = await run('startMerchantOnboarding', {});
    return reply.redirect(onboardingUrl);
  }),
);
app.get('/seller/return', safe(async () => run('syncMerchantAccount', {})));
app.post('/seller/dashboard', safe(async () => run('openMerchantDashboard', {})));
app.post('/charges', safe(async (request) => run('createCharge', request.body ?? {})));
app.get('/charges', safe(async () => run('listCharges', {})));
app.get('/charges/:id', safe(async (request) => run('getCharge', { chargeId: request.params.id })));
app.post(
  '/charges/:id/refund',
  safe(async (request) => run('refundCharge', { chargeId: request.params.id, ...(request.body ?? {}) })),
);
app.get('/paid/:id', safe(async (request) => run('getCharge', { chargeId: request.params.id })));
app.get('/cancelled/:id', async (request) => ({ cancelled: request.params.id }));

await app.listen({ port, host: '127.0.0.1' });
console.log(`Payments smoke server on ${baseUrl}`);
console.log(`Webhook route: ${baseUrl}/payments/webhooks/stripe`);
for (const finding of env.payments.findings) console.log(`[config] ${finding.level} ${finding.message}`);
