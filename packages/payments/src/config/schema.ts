// ── createPayments() config schema ──
// Zod is the single validator for the config. Every option carries a
// `.describe()` text; `listPaymentsConfigOptions()` walks the schema so the docs
// coverage test can prove every option is documented.

import { z } from '@plumbus/core/zod';

const responsibility = z.enum(['provider', 'platform']);
const dashboard = z.enum(['full', 'express', 'none']);
const chargeType = z.enum(['direct', 'destination']);
const interval = z.enum(['day', 'week', 'month', 'year']);
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
const key = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, 'Use 1–40 letters, digits, "_" or "-"');

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

const payoutSchedule = z
  .object({
    interval: z
      .enum(['manual', 'daily', 'weekly', 'monthly'])
      .describe('How often payouts happen; manual = only when requested.'),
    delayDays: z
      .union([z.number().int().min(0).max(31), z.literal('minimum')])
      .optional()
      .describe('Days funds wait before a payout (at most 31); "minimum" = the shortest allowed.'),
    weeklyAnchor: z
      .enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])
      .optional()
      .describe('Weekly payouts: the weekday (Monday to Friday).'),
    monthlyAnchor: z
      .number()
      .int()
      .min(1)
      .max(31)
      .optional()
      .describe('Monthly payouts: the day of the month.'),
  })
  .strict();

const planPrice = z
  .object({
    amount: z
      .number()
      .int()
      .nonnegative()
      .describe('Minor units per period (per seat when perSeat).'),
    currency: currencyCode.describe('Lowercase ISO currency code.'),
    interval: interval.describe('Billing period: day, week, month, or year.'),
    intervalCount: z
      .number()
      .int()
      .min(1)
      .max(36)
      .optional()
      .describe('Periods between payments, e.g. 3 with month = quarterly.'),
    perSeat: z.boolean().optional().describe('Charge per seat; setSeats sets the quantity.'),
  })
  .strict();

const plan = z
  .object({
    name: z.string().min(1).max(100).describe('Plan name shown at checkout and on invoices.'),
    description: z.string().max(500).optional().describe('Plan description shown at checkout.'),
    features: z.array(key).optional().describe('Entitlement feature keys this plan grants.'),
    prices: z
      .record(key, planPrice)
      .refine((value) => Object.keys(value).length > 0, 'Give the plan at least one price')
      .describe('Prices by key, e.g. monthly and yearly.'),
    meters: z.array(key).optional().describe('Usage meters billed on this plan.'),
    trialDays: z
      .number()
      .int()
      .min(1)
      .max(730)
      .optional()
      .describe('Free days before the first payment.'),
  })
  .strict();

const meter = z
  .object({
    name: z.string().min(1).max(100).describe('Meter name shown on invoices.'),
    eventName: z
      .string()
      .regex(/^[a-z0-9_]{1,100}$/)
      .describe('Event name usage is recorded under at the provider.'),
    aggregation: z
      .enum(['sum', 'count', 'last'])
      .optional()
      .describe('How usage in a period adds up (default sum).'),
    unitAmount: z
      .union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d{1,12})?$/)])
      .describe('Minor units per unit of usage; a decimal string allows fractions.'),
    currency: currencyCode.describe('Lowercase ISO currency code.'),
    interval: interval.optional().describe('Billing period of the usage price (default month).'),
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
      .optional()
      .describe('Sellers who charge their own clients. Omit to bill only for the platform.'),
    access: z
      .object({
        sellers: accessPolicy
          .optional()
          .describe('Who may connect an account, create charges, and read their charges.'),
        refunds: accessPolicy.optional().describe('Who may refund. Defaults to access.sellers.'),
        disputes: accessPolicy
          .optional()
          .describe('Who may answer disputes. Defaults to access.refunds.'),
        billing: accessPolicy.optional().describe('Who may change the platform plan subscription.'),
        entitlements: accessPolicy
          .optional()
          .describe('Who may read plan entitlements. Defaults to any signed-in tenant user.'),
      })
      .strict()
      .describe('Access policies for the payments capabilities.'),
    dashboards: z
      .object({
        full: dashboardOption.optional().describe('Offer the full provider dashboard.'),
        express: dashboardOption.optional().describe('Offer the lighter Express dashboard.'),
        none: dashboardOption
          .optional()
          .describe('Offer no provider dashboard; sellers work only inside your app.'),
      })
      .strict()
      .optional()
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
      .union([
        chargeType,
        z
          .object({
            full: chargeType.optional().describe('Charge type for full-dashboard sellers.'),
            express: chargeType.optional().describe('Charge type for Express sellers.'),
            none: chargeType.optional().describe('Charge type for sellers without a dashboard.'),
          })
          .strict(),
      ])
      .optional()
      .describe('How sellers charges move money: direct or destination, overall or per dashboard.'),
    destination: z
      .object({
        onBehalfOf: z
          .boolean()
          .optional()
          .describe('Make the seller the merchant of record on destination charges.'),
      })
      .strict()
      .optional()
      .describe('Destination charge settings.'),
    transfers: z
      .object({
        enabled: z
          .boolean()
          .optional()
          .describe('Platform charges and transfers to sellers (split or delayed payouts).'),
      })
      .strict()
      .optional()
      .describe('Transfers from the platform balance to sellers.'),
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
        reverseTransfer: z
          .boolean()
          .optional()
          .describe('Destination charges: take refunds back from the seller (default true).'),
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
        ui: z
          .enum(['hosted', 'embedded'])
          .optional()
          .describe('Payment page: provider-hosted (default) or embedded in your app.'),
        locale: z
          .string()
          .min(2)
          .max(10)
          .optional()
          .describe('Language of the payment page (default: the browser language).'),
        allowPromotionCodes: z.boolean().optional().describe('Let clients enter promotion codes.'),
        automaticTax: z
          .boolean()
          .optional()
          .describe("Calculate tax with the provider's tax engine."),
        billingAddress: z
          .enum(['auto', 'required'])
          .optional()
          .describe('Collect the billing address only when needed, or always.'),
        phone: z.boolean().optional().describe("Collect the client's phone number."),
        shippingCountries: z
          .array(countryCode)
          .min(1)
          .optional()
          .describe('Collect a shipping address in these countries.'),
        submitType: z
          .enum(['auto', 'pay', 'book', 'donate'])
          .optional()
          .describe('Label of the pay button.'),
      })
      .strict()
      .optional()
      .describe('Payment page settings (charges can override them).'),
    invoices: z
      .object({
        daysUntilDue: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Days the client has to pay an invoice (default 30).'),
      })
      .strict()
      .optional()
      .describe('Invoice settings.'),
    subscriptions: z
      .object({
        enabled: z
          .boolean()
          .optional()
          .describe('Sellers can sell subscriptions to their clients.'),
        platformFeePercent: z
          .union([z.number().min(0).max(100), z.function()])
          .optional()
          .describe('Your cut of each subscription payment, in percent (two decimals).'),
      })
      .strict()
      .optional()
      .describe('Subscriptions sellers sell to their clients.'),
    payouts: z
      .object({
        schedule: payoutSchedule
          .optional()
          .describe('Payout schedule set for new sellers on Express or no dashboard.'),
        sellersMayChangeSchedule: z
          .boolean()
          .optional()
          .describe('Let sellers change their own payout schedule.'),
        instant: z.boolean().optional().describe('Let sellers request instant payouts.'),
      })
      .strict()
      .optional()
      .describe('Seller payout settings.'),
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
    billing: z
      .object({
        customer: z
          .enum(['tenant', 'user', 'seller'])
          .describe('Who pays for the plans: the tenant, each user, or each seller.'),
        plans: z
          .record(key, plan)
          .refine((value) => Object.keys(value).length > 0, 'Define at least one plan')
          .describe('Plans by key.'),
        meters: z.record(key, meter).optional().describe('Usage meters by key.'),
        features: z
          .record(key, z.object({ name: z.string().min(1).max(80) }).strict())
          .optional()
          .describe('Display names of entitlement features.'),
        trialDays: z
          .number()
          .int()
          .min(1)
          .max(730)
          .optional()
          .describe('Free days before the first payment, for every plan.'),
        allowPromotionCodes: z
          .boolean()
          .optional()
          .describe('Let customers enter promotion codes at plan checkout.'),
        automaticTax: z
          .boolean()
          .optional()
          .describe("Calculate tax on plans with the provider's tax engine."),
        prorate: z.boolean().optional().describe('Prorate plan and seat changes (default true).'),
      })
      .strict()
      .optional()
      .describe('Plans the platform bills its own customers for.'),
    urls: z
      .object({
        onboardingReturn: absoluteUrl.optional().describe('Where a seller lands after onboarding.'),
        onboardingRefresh: absoluteUrl
          .optional()
          .describe('Where a seller lands when an onboarding link expired; mint a new link there.'),
        checkoutSuccess: absoluteUrl
          .optional()
          .describe('Where the client lands after paying. {chargeId} is replaced.'),
        checkoutCancel: absoluteUrl
          .optional()
          .describe('Where the client lands after leaving checkout. {chargeId} is replaced.'),
        checkoutReturn: absoluteUrl
          .optional()
          .describe('Embedded payment pages: where the client lands after paying.'),
        setupSuccess: absoluteUrl
          .optional()
          .describe('Where the client lands after saving a payment method. {clientId}.'),
        setupCancel: absoluteUrl
          .optional()
          .describe('Where the client lands if they leave saving a payment method.'),
        portalReturn: absoluteUrl
          .optional()
          .describe('Where the client portal sends the client back to.'),
        billingSuccess: absoluteUrl
          .optional()
          .describe('Where a customer lands after subscribing to a plan.'),
        billingCancel: absoluteUrl
          .optional()
          .describe('Where a customer lands if they leave plan checkout.'),
        billingPortalReturn: absoluteUrl
          .optional()
          .describe('Where the billing portal sends the customer back to.'),
        linkCompleted: absoluteUrl
          .optional()
          .describe('Where a client lands after paying through a payment link.'),
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
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, 'Use 1–40 lowercase letters, digits, "_" or "-"')
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
    for (const [name, child] of Object.entries(inner.shape as Record<string, z.ZodTypeAny>)) {
      const path = prefix ? `${prefix}.${name}` : name;
      out.push(path);
      walk(child, path, out);
    }
    return;
  }
  if (inner instanceof z.ZodUnion) {
    for (const option of inner.options as z.ZodTypeAny[]) {
      walk(option, prefix, out);
    }
    return;
  }
  // Records keyed by the app (plans, meters): document the shape of one entry as `<key>`.
  if (inner instanceof z.ZodRecord) {
    walk(inner.valueSchema as z.ZodTypeAny, `${prefix}.<key>`, out);
  }
}
