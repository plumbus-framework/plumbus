// Payments for the tutoring test app: tutors (users) connect Stripe and charge
// their students. Wired exactly as node_modules/@plumbus/payments/instructions/wiring.md
// describes. STRIPE_API_BASE points the Stripe SDK at the local simulator
// (stripe-sim/); leave it unset to talk to Stripe test mode.
import { createPayments, percentOf } from '@plumbus/payments';
import { stripeProvider } from '@plumbus/payments-stripe';

const simulator = process.env.STRIPE_API_BASE ? new URL(process.env.STRIPE_API_BASE) : null;
const appUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';

export const payments = createPayments({
  provider: stripeProvider({
    secretKey: () => process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecrets: () => (process.env.STRIPE_WEBHOOK_SECRETS ?? '').split(',').filter(Boolean),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    ...(simulator
      ? {
          api: {
            host: simulator.hostname,
            port: Number(simulator.port),
            protocol: simulator.protocol === 'http:' ? ('http' as const) : ('https' as const),
          },
          maxNetworkRetries: 0,
        }
      : {}),
  }),
  seller: { owner: 'user' },
  access: { sellers: { roles: ['tutor'] } },
  // Tutors choose: the full Stripe Dashboard (Stripe carries losses) or the lighter
  // Express dashboard (the platform carries fees + losses and charges more for it).
  dashboards: { full: true, express: true },
  defaultDashboard: 'full',
  countries: { allowed: ['US', 'GB'], default: 'US' },
  currencies: ['usd', 'gbp'],
  platformFee: ({ amount, merchant }) =>
    merchant.feesCollector === 'platform' ? percentOf(amount, 8) + 30 : percentOf(amount, 5),
  refunds: { refundPlatformFee: true },
  checkout: { expiresAfterMinutes: 60 },
  urls: {
    onboardingReturn: `${appUrl}/tutor/payments/connected`,
    onboardingRefresh: `${appUrl}/tutor/payments/connect`,
    checkoutSuccess: `${appUrl}/lessons/paid/{chargeId}`,
    checkoutCancel: `${appUrl}/lessons/pay/{chargeId}`,
  },
  appId: 'payments-connect-app',
});
