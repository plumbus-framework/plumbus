// Loads the *built* framework packages (dist) without adding this smoke app to
// the pnpm workspace: @plumbus/core, @plumbus/payments, @plumbus/payments-stripe,
// and fastify resolved from @plumbus/payments' own node_modules (one fastify
// instance, the same copy the webhook route registers against).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// lib -> payments-stripe-smoke -> examples -> repo root
export const repoRoot = path.resolve(import.meta.dirname, '../../..');

const dists = {
  core: path.join(repoRoot, 'packages/plumbus-core/dist/index.js'),
  payments: path.join(repoRoot, 'packages/payments/dist/index.js'),
  stripe: path.join(repoRoot, 'packages/payments-stripe/dist/index.js'),
  stripeTesting: path.join(repoRoot, 'packages/payments-stripe/dist/testing/index.js'),
};

for (const dist of Object.values(dists)) {
  if (!existsSync(dist)) {
    console.error(
      `[deps] Missing build output: ${dist}\n` +
        'Build the framework packages first, from the repo root:\n' +
        '  pnpm turbo run build --filter=@plumbus/payments-stripe',
    );
    process.exit(1);
  }
}

const fileUrl = (p) => pathToFileURL(p).href;
const require = createRequire(path.join(repoRoot, 'packages/payments/package.json'));

const { default: Fastify } = await import(fileUrl(require.resolve('fastify')));
const core = await import(fileUrl(dists.core));
const payments = await import(fileUrl(dists.payments));
const stripe = await import(fileUrl(dists.stripe));
const stripeTesting = await import(fileUrl(dists.stripeTesting));

export { Fastify };
// Note: @plumbus/core/testing and @plumbus/payments/testing import vitest, so a
// plain `node` script cannot load them; lib/app.mjs builds its own context.
export const { buildCapabilityRuntimeDeps, CapabilityRegistry, createExecutionContext, executeCapability } =
  core;
export const { createPayments, registerPaymentRoutes, paymentsServiceAuth, PaymentEventName } =
  payments;
export const { stripeProvider, STRIPE_API_VERSION, STRIPE_THIN_EVENTS } = stripe;
export const { createStripeHttpStub, signStripeWebhook, stripeSnapshotEvent, stripeThinAccountEvent } =
  stripeTesting;
