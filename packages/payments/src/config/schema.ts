// ── createPayments() config schema ──
// Zod is the single validator for the config. Every option carries a
// `.describe()` text; `listPaymentsConfigOptions()` walks the schema so the docs
// coverage test can prove every option is documented.

import { z } from '@plumbus/core/zod';

const responsibility = z.enum(['provider', 'platform']);
const dashboard = z.enum(['full', 'express', 'none']);
const accessPolicy = z
  .object({
    roles: z.array(z.string()).optional(),
    scopes: z.array(z.string()).optional(),
    public: z.boolean().optional(),
    tenantScoped: z.boolean().optional(),
    serviceAccounts: z.array(z.string()).optional(),
  })
  .strict();

const dashboardOption = z.union([
  z.literal(true),
  z
    .object({
      fees: responsibility
        .optional()
        .describe("Who pays the provider's processing fees on direct charges."),
      losses: responsibility
        .optional()
        .describe("Who covers negative balances (refunds or disputes the seller can't pay)."),
    })
    .strict(),
]);

const countryCode = z
  .string()
  .regex(/^[A-Z]{2}$/, 'Use an ISO 3166-1 alpha-2 code in upper case, e.g. "US"');
const currencyCode = z
  .string()
  .regex(/^[a-z]{3}$/, 'Use a lowercase ISO 4217 currency code, e.g. "usd"');
const absoluteUrl = z.string().url();

const platformFeeRule = z
  .object({
    percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Percentage of the charge amount, 0–100, rounded half-up to a minor unit.'),
    fixed: z
      .record(currencyCode, z.number().int().nonnegative())
      .optional()
      .describe('Fixed amount per charge in minor units, keyed by currency.'),
  })
  .strict();

export const paymentsConfigSchema = z
  .object({
    provider: z
      .custom<unknown>(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          typeof (value as { id?: unknown }).id === 'string' &&
          typeof (value as { createCharge?: unknown }).createCharge === 'function',
        { message: 'provider must be a payment provider adapter, e.g. stripeProvider()' },
      )
      .describe('Payment provider adapter, e.g. stripeProvider() from @plumbus/payments-stripe.'),
    seller: z
      .object({
        owner: z
          .enum(['user', 'tenant'])
          .describe('user: each user connects their own account. tenant: one per tenant.'),
      })
      .strict()
      .describe('Who owns a seller account.'),
    access: z
      .object({
        sellers: accessPolicy.describe(
          'Who may connect an account, create charges, and read their charges.',
        ),
        refunds: accessPolicy.optional().describe('Who may refund. Defaults to access.sellers.'),
      })
      .strict()
      .describe('Access policies for the seller-facing capabilities.'),
    dashboards: z
      .object({
        full: dashboardOption.optional().describe('Offer the full provider dashboard.'),
        express: dashboardOption.optional().describe('Offer the lighter Express dashboard.'),
        none: dashboardOption
          .optional()
          .describe('Offer no provider dashboard; sellers work only inside your app.'),
      })
      .strict()
      .refine((value) => Object.keys(value).length > 0, {
        message: 'Offer at least one dashboard (full, express, or none)',
      })
      .describe('Dashboards offered to sellers, with the responsibilities each carries.'),
    defaultDashboard: dashboard
      .optional()
      .describe('Used when several dashboards are offered and the seller does not choose.'),
    onboarding: z
      .object({
        modes: z
          .array(z.enum(['hosted', 'embedded']))
          .min(1)
          .optional()
          .describe('hosted: provider page. embedded: components inside your app.'),
        collect: z
          .enum(['currently_due', 'eventually_due'])
          .optional()
          .describe('Collect only what is due now, or everything that will be due.'),
      })
      .strict()
      .optional()
      .describe('How sellers onboard.'),
    countries: z
      .object({
        allowed: z
          .array(countryCode)
          .min(1)
          .optional()
          .describe('Countries sellers may register in. Omit to allow any.'),
        default: countryCode.optional().describe('Country used when the seller does not choose.'),
      })
      .strict()
      .optional()
      .describe('Seller countries.'),
    chargeType: z
      .enum(['direct', 'destination', 'separate'])
      .optional()
      .describe('How money moves. Only direct is available in this release.'),
    currencies: z
      .array(currencyCode)
      .min(1)
      .optional()
      .describe('Currencies sellers may charge in. Omit to allow any.'),
    platformFee: z
      .union([platformFeeRule, z.function()])
      .optional()
      .describe('Your cut of each charge: a rule or a function. Omit for none.'),
    refunds: z
      .object({
        refundPlatformFee: z
          .boolean()
          .optional()
          .describe('Return your platform fee to the seller when a charge is refunded.'),
      })
      .strict()
      .optional()
      .describe('Refund behavior.'),
    checkout: z
      .object({
        expiresAfterMinutes: z
          .number()
          .int()
          .min(30)
          .max(1440)
          .optional()
          .describe('How long a payment link stays valid, 30–1440 minutes.'),
      })
      .strict()
      .optional()
      .describe('Hosted checkout settings.'),
    embedded: z
      .object({
        allowRefunds: z
          .boolean()
          .optional()
          .describe('Let sellers refund from embedded payment components.'),
        allowDisputeManagement: z
          .boolean()
          .optional()
          .describe('Let sellers respond to disputes from embedded components.'),
      })
      .strict()
      .optional()
      .describe('Embedded component permissions.'),
    urls: z
      .object({
        onboardingReturn: absoluteUrl.describe('Where a seller lands after onboarding.'),
        onboardingRefresh: absoluteUrl.describe(
          'Where a seller lands when an onboarding link expired; mint a new link there.',
        ),
        checkoutSuccess: absoluteUrl.describe(
          'Where the client lands after paying. {chargeId} is replaced.',
        ),
        checkoutCancel: absoluteUrl.describe(
          'Where the client lands after leaving checkout. {chargeId} is replaced.',
        ),
      })
      .strict()
      .describe('Absolute redirect URLs.'),
    webhooks: z
      .object({
        path: z
          .string()
          .regex(/^\/[A-Za-z0-9/_:.-]*$/, 'Must be an absolute route path')
          .optional()
          .describe('Webhook route path. Default /payments/webhooks/<provider id>.'),
        bodyLimitBytes: z
          .number()
          .int()
          .min(1024)
          .max(10 * 1024 * 1024)
          .optional()
          .describe('Maximum webhook body size in bytes (default 1 MiB).'),
        storePayload: z
          .boolean()
          .optional()
          .describe('Keep each event body in the ledger (off: bodies carry personal data).'),
      })
      .strict()
      .optional()
      .describe('Webhook route settings.'),
    appId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Stamped into provider metadata so several apps can share one account.'),
  })
  .strict();

/** Every config option path, e.g. `dashboards.express.fees`, for docs coverage. */
export function listPaymentsConfigOptions(): string[] {
  const paths: string[] = [];
  walk(paymentsConfigSchema, '', paths);
  return paths;
}

function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current = schema;
  for (;;) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
    } else if (current instanceof z.ZodEffects) {
      current = current.innerType();
    } else {
      return current;
    }
  }
}

function walk(schema: z.ZodTypeAny, prefix: string, out: string[]): void {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      const path = prefix ? `${prefix}.${key}` : key;
      out.push(path);
      walk(child, path, out);
    }
    return;
  }
  if (inner instanceof z.ZodUnion) {
    for (const option of inner.options as z.ZodTypeAny[]) {
      walk(option, prefix, out);
    }
  }
}
