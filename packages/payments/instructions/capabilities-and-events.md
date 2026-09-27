# Calling payments capabilities and reacting to events

## Seller-facing capabilities

All run as the signed-in caller; the seller is derived from auth, never from input. Access: `access.sellers` (refunds: `access.refunds`).

| Capability | Kind | Input | Output |
|---|---|---|---|
| `payments.startMerchantOnboarding` | action | `{ dashboard?, country?, email?, displayName?, mode? }` | `{ merchantAccount, created, onboardingUrl, expiresAt }` |
| `payments.createMerchantSession` | action | `{ components? }` | `{ clientSecret, expiresAt, publishableKey, components }` |
| `payments.getMerchantAccount` | query | `{}` | `{ merchantAccount \| null }` |
| `payments.syncMerchantAccount` | action | `{}` | `{ merchantAccount }` (pulls fresh status now) |
| `payments.openMerchantDashboard` | action | `{}` | `{ url, dashboard }` (not for `dashboard: 'none'`) |
| `payments.createCharge` | action | `{ amount, currency, description, client?, metadata?, requestId? }` | `{ charge, created }` |
| `payments.listCharges` | query | `{ status?, limit?, offset? }` | `{ charges }` |
| `payments.getCharge` | query | `{ chargeId }` | `{ charge, refunds }` |
| `payments.refundCharge` | action | `{ chargeId, amount?, reason?, requestId? }` | `{ refund, created }` |

- `merchantAccount.status`: `onboarding` → `active` (can take payments) → `restricted` (provider needs more information) / `closed`. Show `requirementsDue` to the seller and send them back through `startMerchantOnboarding` when it is not empty.
- `createCharge` needs `merchantAccount.chargesEnabled`. Give the client `charge.url` (valid until `charge.expiresAt`). `client` (`email`/`reference`/`userId`/`name`) reuses one provider customer per client.
- Pass a stable `requestId` from forms and retries: the same `requestId` returns the same charge or refund instead of creating a second one.
- Errors: `notFound` (no account connected / charge not the caller's), `conflict` (cannot take payments yet, dashboard change, unpaid refund), `validation` (country, currency, amount, provider-rejected values with the provider's message), `forbidden` (access policy).

### From the browser

Use the generated client hooks for these capabilities like any other capability. Redirect to `onboardingUrl`; for embedded components, fetch `createMerchantSession` and hand `clientSecret` + `publishableKey` to the provider's component library (Stripe: `@stripe/connect-js`).

### From your own capabilities

When your app decides the price (a booking, an invoice), call `createCharge` from a server capability so the amount is not browser-controlled:

```ts
export const requestLessonPayment = defineCapability({
  name: 'requestLessonPayment',
  kind: 'action',
  domain: 'lessons',
  input: z.object({ lessonId: z.string() }),
  output: z.object({ url: z.string().nullable() }),
  access: { roles: ['tutor'] },
  effects: {
    data: ['Lesson'],
    events: [],
    external: ['payments:stripe'], // keeps this capability out of a DB transaction during the Stripe call
    capabilities: ['payments.createCharge'],
    ai: false,
  },
  async handler(ctx, input) {
    const lesson = await ctx.data.Lesson.findById(input.lessonId);
    if (!lesson) throw ctx.errors.notFound('Lesson not found');
    const { charge } = (await ctx.capabilities.invoke('payments.createCharge', {
      amount: lesson.priceMinor,
      currency: lesson.currency,
      description: lesson.title,
      client: { email: lesson.studentEmail, reference: lesson.studentId },
      metadata: { lessonId: lesson.id },
      requestId: `lesson:${lesson.id}`,
    })) as { charge: { url: string | null } };
    return { url: charge.url };
  },
});
```

The invoked capability runs as the same caller, so the tutor must be allowed by `access.sellers`. Declare the provider in `effects.external` (or set `transactional: false`): otherwise your action opens a database transaction and holds it while the provider is called.

## Events to react to

Write `eventHandler` capabilities with `trigger: { event: '<name>' }`. Every payload carries `merchantAccountId`, `ownerType`, `ownerId`; charge events add `chargeId`, `amount`, `currency`.

| Event | When | Typical reaction |
|---|---|---|
| `payments.merchant.updated` | Seller status, abilities, or requirements changed | Notify the seller; unlock "request payment" when `chargesEnabled` |
| `payments.charge.created` | Seller created a payment link | Send the link |
| `payments.charge.paid` | Client paid | **Deliver / grant access / mark the order paid** |
| `payments.charge.failed` | A delayed method (bank debit) failed | Tell the seller |
| `payments.charge.expired` | Link expired unpaid | Offer a new link |
| `payments.charge.refunded` | Money returned (`amountRefunded`, `fullyRefunded`) | Revoke if fully refunded |
| `payments.refund.failed` | A refund could not complete | Tell the seller |
| `payments.dispute.opened` / `updated` / `closed` | Client disputed a charge (`status`, `evidenceDueBy`) | Alert the seller before `evidenceDueBy` |

Handlers must be idempotent on `chargeId`/`disputeId` (events are delivered at least once). Put your own metadata (`lessonId`) on the charge and read it back with `getCharge` or `ctx.data.PaymentCharge`.

## Reading payments in app code

`ctx.data.PaymentCharge`, `ctx.data.PaymentMerchantAccount`, etc. are normal tenant-scoped repositories (row types exported as `PaymentChargeRow`, …). Read them freely; **do not write them** — only the payments capabilities and the webhook worker update them.
