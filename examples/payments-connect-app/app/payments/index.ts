// Payments for the tutoring test app: tutors (users) connect Stripe and charge
// their students; the school platform bills schools for plans and AI usage and
// pays tutors their share of group classes. Wired exactly as
// node_modules/@plumbus/payments/instructions/wiring.md describes.
// STRIPE_API_BASE points the Stripe SDK at the local simulator (stripe-sim/);
// leave it unset to talk to Stripe test mode.
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
  access: { sellers: { roles: ['tutor'] }, billing: { roles: ['school-admin'] } },
  // Tutors choose: the full Stripe Dashboard (their own account, direct charges,
  // Stripe carries losses) or the lighter Express dashboard (destination charges:
  // the school is the merchant of record, pays fees, covers losses, charges more).
  dashboards: { full: true, express: true },
  defaultDashboard: 'full',
  countries: { allowed: ['US', 'GB'], default: 'US' },
  currencies: ['usd', 'gbp'],
  platformFee: ({ amount, merchant }) =>
    merchant.feesCollector === 'platform' ? percentOf(amount, 8) + 30 : percentOf(amount, 5),
  refunds: { refundPlatformFee: true, reverseTransfer: true },
  checkout: { expiresAfterMinutes: 60 },
  invoices: { daysUntilDue: 14 },
  subscriptions: { enabled: true, platformFeePercent: 5 },
  payouts: {
    schedule: { interval: 'weekly', weeklyAnchor: 'friday' },
    sellersMayChangeSchedule: true,
    instant: true,
  },
  transfers: { enabled: true },
  // The platform's own plans for schools (the tenant is the billing customer).
  billing: {
    customer: 'tenant',
    plans: {
      starter: {
        name: 'Starter',
        description: 'Lessons and payments for one school',
        features: ['lessons'],
        prices: { monthly: { amount: 2900, currency: 'usd', interval: 'month' } },
      },
      school: {
        name: 'School',
        description: 'Per tutor seat, with the AI tutor billed by usage',
        features: ['lessons', 'ai-tutor'],
        prices: {
          monthly: { amount: 900, currency: 'usd', interval: 'month', perSeat: true },
          yearly: { amount: 9000, currency: 'usd', interval: 'year', perSeat: true },
        },
        meters: ['aiTokens'],
      },
    },
    meters: {
      aiTokens: { name: 'AI tutor tokens', eventName: 'ai_tokens', unitAmount: '0.002', currency: 'usd' },
    },
    features: { 'ai-tutor': { name: 'AI tutor' }, lessons: { name: 'Lessons' } },
  },
  urls: {
    onboardingReturn: `${appUrl}/tutor/payments/connected`,
    onboardingRefresh: `${appUrl}/tutor/payments/connect`,
    checkoutSuccess: `${appUrl}/lessons/paid/{chargeId}`,
    checkoutCancel: `${appUrl}/lessons/pay/{chargeId}`,
    checkoutReturn: `${appUrl}/lessons/returned/{chargeId}`,
    setupSuccess: `${appUrl}/students/card-saved/{clientId}`,
    setupCancel: `${appUrl}/students/{clientId}`,
    portalReturn: `${appUrl}/students`,
    billingSuccess: `${appUrl}/school/billing/done`,
    billingCancel: `${appUrl}/school/billing`,
    billingPortalReturn: `${appUrl}/school/billing`,
    linkCompleted: `${appUrl}/thanks`,
  },
  appId: 'payments-connect-app',
});
