// Run the payments test app for manual exploration.
//
//   node scripts/dev.mjs                  # Stripe simulator (default): click through in a browser
//   node scripts/dev.mjs --stripe         # real Stripe TEST mode: STRIPE_SECRET_KEY=sk_test_… and
//                                         #   STRIPE_WEBHOOK_SECRETS from `stripe listen` (see README)
//
// Starts a private Postgres, migrates, starts the app (API + worker), creates
// webhook destinations on the simulator, and prints tokens + ready-to-paste
// commands. Ctrl-C stops everything (the Postgres container is removed).
import { randomBytes } from 'node:crypto';
import { createStripeSimulator, SIM_SECRETS } from '../stripe-sim/server.mjs';
import {
  baseEnv,
  freePort,
  linkPackages,
  loadFastify,
  plumbus,
  signJwt,
  startApp,
  startDatabase,
} from './lib.mjs';

const useStripe = process.argv.includes('--stripe');
const log = (line) => console.log(`  · ${line}`);
const stops = [];

async function shutdown() {
  for (const stop of stops.reverse()) {
    try {
      await stop();
    } catch {
      // best effort
    }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

linkPackages({ quiet: true });
const db = await startDatabase({ log });
stops.push(db.stop);

const appPort = Number(process.env.PORT ?? (await freePort()));
const appUrl = `http://127.0.0.1:${appPort}`;
const authSecret = randomBytes(24).toString('hex');
let stripeEnv;
let simUrl = null;

if (useStripe) {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  if (!/^(sk|rk)_test_/.test(key)) {
    console.error('--stripe needs STRIPE_SECRET_KEY set to a TEST key (sk_test_… or rk_test_…).');
    await shutdown();
  }
  if (!process.env.STRIPE_WEBHOOK_SECRETS) {
    console.error('--stripe needs STRIPE_WEBHOOK_SECRETS (the whsec_… printed by `stripe listen`).');
    await shutdown();
  }
  stripeEnv = {
    STRIPE_SECRET_KEY: key,
    STRIPE_WEBHOOK_SECRETS: process.env.STRIPE_WEBHOOK_SECRETS,
    STRIPE_PUBLISHABLE_KEY: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  };
} else {
  const Fastify = await loadFastify();
  const simPort = await freePort();
  simUrl = `http://127.0.0.1:${simPort}`;
  const sim = createStripeSimulator({ Fastify, baseUrl: simUrl, log: (l) => log(`sim ${l}`) });
  await sim.app.listen({ port: simPort, host: '127.0.0.1' });
  stops.push(() => sim.app.close());
  stripeEnv = {
    STRIPE_SECRET_KEY: 'sk_test_simulator_0000000000000000',
    STRIPE_WEBHOOK_SECRETS: `${SIM_SECRETS.snapshot},${SIM_SECRETS.thin}`,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_simulator',
    STRIPE_API_BASE: simUrl,
  };
}

const env = baseEnv({ ...db.env, AUTH_SECRET: authSecret, APP_BASE_URL: appUrl, ...stripeEnv });
await plumbus(['migrate', 'generate'], env);
await plumbus(['migrate', 'apply', '--create-db'], env);
const app = await startApp({ env, port: appPort, log });
stops.push(() => app.stop());
if (simUrl) {
  await plumbus(['payments', 'webhooks', 'setup', '--url', `${appUrl}/payments/webhooks/stripe`], env);
}
// The school plans (billing.plans) at Stripe or in the simulator; unchanged plans change nothing.
await plumbus(['payments', 'catalog', 'sync'], env);

const tutor = signJwt(authSecret, { sub: 'tutor-ada', tenant_id: 'school-north', roles: ['tutor'] });
const admin = signJwt(authSecret, { sub: 'admin-north', tenant_id: 'school-north', roles: ['school-admin'] });
console.log(`
payments-connect-app is running
  app        ${appUrl}
  ${simUrl ? `stripe sim ${simUrl}   (state: ${simUrl}/_sim/state)` : 'stripe     TEST mode (keep `stripe listen` running)'}
  database   ${db.env.DB_NAME} on ${db.env.DB_HOST}:${db.env.DB_PORT}

Tutor and school-admin tokens (tenant school-north):
  export T=${tutor}
  export A=${admin}

Try:
  curl -s -X POST ${appUrl}/api/payments/start-merchant-onboarding -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{}'
    → open onboardingUrl and finish onboarding
  curl -s ${appUrl}/api/payments/get-merchant-account -H "authorization: Bearer $T"
  curl -s -X POST ${appUrl}/api/lessons/create-lesson -H "authorization: Bearer $T" -H 'content-type: application/json' \\
       -d '{"title":"Algebra","studentEmail":"parent@example.com","priceMinor":4000,"currency":"usd"}'
  curl -s -X POST ${appUrl}/api/lessons/request-lesson-payment -H "authorization: Bearer $T" -H 'content-type: application/json' -d '{"lessonId":"<id>"}'
    → open url and pay${useStripe ? ' with 4242 4242 4242 4242' : ''}
  curl -s "${appUrl}/api/lessons/get-lesson?lessonId=<id>" -H "authorization: Bearer $T"
  curl -s -X POST ${appUrl}/api/payments/subscribe-to-plan -H "authorization: Bearer $A" -H 'content-type: application/json' \
       -d '{"plan":"school","price":"monthly","quantity":3}'
    → open subscription.checkoutUrl and pay, then:
  curl -s ${appUrl}/api/payments/get-entitlements -H "authorization: Bearer $A"

Ctrl-C to stop.`);
