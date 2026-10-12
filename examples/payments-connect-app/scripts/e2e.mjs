// End-to-end run of the payments test app on the real Plumbus runtime.
//
//   node scripts/e2e.mjs                 # everything
//   node scripts/e2e.mjs --only refunds  # setup + one scenario (plus the ones it depends on)
//   node scripts/e2e.mjs --keep          # leave Postgres, the simulator, and the app running
//
// Steps: link the built packages → typecheck the app → private Postgres
// (docker, or E2E_DB_*) → `plumbus migrate generate` + `apply --create-db` →
// Stripe simulator → `plumbus dev` (API + worker + outbox in one process) →
// `plumbus payments webhooks setup` + `catalog check/sync` + `doctor --live` →
// scenarios over HTTP.
// Exit code is non-zero on any failure. Needs `pnpm build` at the repo root.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { scenarios } from '../scenarios/index.mjs';
import { createStripeSimulator, SIM_SECRETS } from '../stripe-sim/server.mjs';
import {
  appRoot,
  baseEnv,
  caller,
  freePort,
  linkPackages,
  loadFastify,
  loadPostgres,
  plumbus,
  repoRoot,
  simClient,
  startApp,
  startDatabase,
  waitFor,
} from './lib.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;
const verbose = args.includes('--verbose');

const log = (line) => console.log(`  · ${line}`);
const cleanup = [];
let failed = 0;

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function step(title, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`[  OK  ] ${title} (${Date.now() - started} ms)`);
    return result;
  } catch (err) {
    console.log(`[ FAIL ] ${title}\n         ${String(err.message).split('\n').join('\n         ')}`);
    throw err;
  }
}

async function main() {
  console.log('\npayments-connect-app — end-to-end\n' + '='.repeat(34));

  await step('Link built packages into the app', () => linkPackages({ quiet: true }));
  await step('Typecheck the app against the package types', () =>
    execFileSync(path.join(repoRoot, 'node_modules/.bin/tsc'), ['-p', path.join(appRoot, 'tsconfig.json')], {
      stdio: 'pipe',
    }),
  );

  const db = await step('Start a private Postgres', () => startDatabase({ log }));
  if (!keep) cleanup.push(db.stop);

  const Fastify = await loadFastify();
  const simPort = await freePort();
  const simUrl = `http://127.0.0.1:${simPort}`;
  const sim = createStripeSimulator({ Fastify, baseUrl: simUrl, log: verbose ? (l) => log(`sim ${l}`) : () => {} });
  await step('Start the Stripe simulator', () => sim.app.listen({ port: simPort, host: '127.0.0.1' }));
  if (!keep) cleanup.push(() => sim.app.close());

  const appPort = await freePort();
  const appUrl = `http://127.0.0.1:${appPort}`;
  const authSecret = randomBytes(24).toString('hex');
  const env = baseEnv({
    ...db.env,
    AUTH_SECRET: authSecret,
    APP_BASE_URL: appUrl,
    STRIPE_SECRET_KEY: 'sk_test_simulator_0000000000000000',
    STRIPE_WEBHOOK_SECRETS: `${SIM_SECRETS.snapshot},${SIM_SECRETS.thin}`,
    STRIPE_PUBLISHABLE_KEY: 'pk_test_simulator',
    STRIPE_API_BASE: simUrl,
  });

  await step('plumbus migrate generate (payments entities, bigint amounts)', async () => {
    const output = await plumbus(['migrate', 'generate'], env);
    assert(/payment_charge|PaymentCharge/i.test(output) || output.includes('entity schema'), output);
  });
  await step('plumbus migrate apply --create-db', () => plumbus(['migrate', 'apply', '--create-db'], env));

  const postgres = await loadPostgres();
  const sql = postgres({
    host: db.env.DB_HOST,
    port: Number(db.env.DB_PORT),
    user: db.env.DB_USER,
    password: db.env.DB_PASSWORD,
    database: db.env.DB_NAME,
    onnotice: () => {},
  });
  cleanup.push(() => sql.end({ timeout: 2 }));

  await step('Amount columns are 64-bit', async () => {
    const rows = await sql`select column_name, data_type from information_schema.columns
      where table_name = 'payment_charge' and column_name in ('amount', 'platform_fee_amount', 'amount_refunded')`;
    assert(rows.length === 3 && rows.every((r) => r.data_type === 'bigint'), JSON.stringify(rows));
  });

  const app = await step('Start the app (plumbus dev: API + worker + outbox)', () =>
    startApp({ env, port: appPort, log }),
  );
  if (!keep) cleanup.push(() => app.stop());

  const webhookUrl = `${appUrl}/payments/webhooks/stripe`;
  await step('plumbus payments webhooks setup', async () => {
    const output = await plumbus(['payments', 'webhooks', 'setup', '--url', webhookUrl], env);
    assert((output.match(/created/g) ?? []).length === 2, output);
  });
  await step('plumbus payments catalog check fails before the first sync', async () => {
    const failed = await plumbus(['payments', 'catalog', 'check'], env).then(
      () => null,
      (err) => err.message,
    );
    assert(failed?.includes('create product plan school'), failed ?? 'catalog check passed on an empty catalog');
  });
  await step('plumbus payments catalog sync', async () => {
    const output = await plumbus(['payments', 'catalog', 'sync'], env);
    assert(output.includes('plumbus:payments-connect-app:school:monthly →'), output);
    const again = await plumbus(['payments', 'catalog', 'sync'], env);
    assert(again.includes('Catalog already up to date'), again);
  });
  await step('plumbus payments catalog check passes after it', async () => {
    const output = await plumbus(['payments', 'catalog', 'check'], env);
    assert(output.includes('Catalog matches'), output);
  });
  const doctor = await step('plumbus payments doctor --live', () =>
    plumbus(['payments', 'doctor', '--live', '--webhook-url', webhookUrl], env),
  );

  const t = {
    appUrl,
    sim: simClient(simUrl),
    sql,
    assert,
    waitFor,
    as: (identity) => caller(appUrl, authSecret, identity),
    shared: { doctor },
  };

  console.log('\nScenarios');
  const selected = only ? scenarios.slice(0, scenarios.findIndex((s) => s.id === only) + 1) : scenarios;
  if (only && selected.length === 0) throw new Error(`unknown scenario ${only}`);
  for (const scenario of selected) {
    try {
      await step(`${scenario.id} — ${scenario.title}`, () => scenario.run(t));
    } catch {
      failed += 1;
      if (verbose) console.log(app.output.slice(-40).join('\n'));
      break; // later scenarios build on earlier ones
    }
  }

  if (keep) {
    console.log(`\nKept running: app ${appUrl}, simulator ${simUrl}, database ${db.env.DB_NAME} on ${db.env.DB_HOST}:${db.env.DB_PORT}`);
    console.log('Stop with Ctrl-C (the Postgres container stays until `docker stop` if --keep was used).');
  }
}

try {
  await main();
} catch {
  failed += 1;
} finally {
  if (!keep) {
    for (const stop of cleanup.reverse()) {
      try {
        await stop();
      } catch {
        // best effort
      }
    }
  }
  console.log(failed ? `\nFAILED (${failed})` : `\nPASSED — ${scenarios.length} scenarios`);
  process.exitCode = failed ? 1 : 0;
}
