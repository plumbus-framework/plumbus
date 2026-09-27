# Calling payments capabilities and reacting to events

All capabilities have domain `payments` (canonical names `payments.createCharge`, …) and run as the signed-in caller; the seller or billing customer is derived from auth, never from input. A capability exists only when its feature is on (and the provider supports it): for example `createSubscription` only with `subscriptions.enabled`.

## Sellers and their charges

Access: `access.sellers` unless noted.

| Capability | Kind | Input | Output |
|---|---|---|---|
| `startMerchantOnboarding` | action | `{ dashboard?, country?, email?, displayName?, mode? }` | `{ merchantAccount, created, onboardingUrl, expiresAt }` |
| `createMerchantSession` | action | `{ components? }` | `{ clientSecret, expiresAt, publishableKey, components }` |
| `getMerchantAccount` | query | `{}` | `{ merchantAccount \| null }` |
| `syncMerchantAccount` | action | `{}` | `{ merchantAccount }` (pulls fresh status now) |
| `openMerchantDashboard` | action | `{}` | `{ url, dashboard }` (not for `dashboard: 'none'`) |
| `createCharge` | action | `{ amount? \| items? \| customAmount?, currency, description, client?, collection?, ui?, capture?, saveMethod?, options?, dueInDays?, metadata?, requestId? }` | `{ charge, created }` |
| `listCharges` | query | `{ status?, collection?, clientId?, limit?, offset? }` | `{ charges }` |
| `getCharge` | query | `{ chargeId }` | `{ charge, refunds }` |
| `refundCharge` | action (`access.refunds`) | `{ chargeId, amount?, reason?, requestId? }` | `{ refund, created }` |
| `captureCharge` | action | `{ chargeId, amount? }` | `{ charge }` |
| `cancelCharge` | action | `{ chargeId }` | `{ charge }` (expires a page, voids an invoice, releases a hold) |

- `merchantAccount.status`: `onboarding` → `active` (can take payments) → `restricted` (provider needs more information) / `closed`. `chargeType` is `direct` or `destination`; a direct seller needs `chargesEnabled`, a destination seller `transfersEnabled`. Show `requirementsDue` and send the seller back through `startMerchantOnboarding` when it is not empty.
- `createCharge` takes exactly one of `amount`, `items` (`[{ name, description?, unitAmount, quantity? }]`), or `customAmount` (`{ minimum?, maximum?, preset? }`: the client chooses — tips, donations). Give the client `charge.url` (valid until `charge.expiresAt`); with `ui: 'embedded'` the page is mounted in yours from `charge.checkout` (`clientSecret`, `publishableKey`, `accountId`) and `url` is null.
- `collection: 'invoice'` emails an invoice (needs `client.email`); `charge.url` is its payment page. `capture: 'manual'` holds the amount: the charge becomes `authorized`, then `captureCharge` (all or part; the fee is recomputed on the captured amount) or `cancelCharge`. `saveMethod: true` keeps the card for `chargeSavedMethod`. `options` overrides the page settings (`locale`, `allowPromotionCodes`, `automaticTax`, `billingAddress`, `phone`, `shippingCountries`, `submitType`, `statementDescriptorSuffix`).
- Charges record `amount` (items before discounts and tax), `amountDiscount`, `amountTax`, and `amountTotal` (what the client paid). Refunds are capped at `amountTotal`.
- `client` (`email`/`reference`/`userId`/`name`) reuses one provider customer per client. Lookup order: `reference`, then `userId`, then `email`; a client found only by `userId` or `email` is reused only if it has no different `reference`/`userId` (siblings may share a parent's email). Pass `reference` whenever two clients can share an email.
- Pass a stable `requestId` from forms and retries: the same `requestId` returns the same charge or refund instead of creating a second one, and finishes one an earlier attempt saved but never sent (crash, lost response). Reusing a `requestId` for a different request is a `conflict` with `reason: 'payments_request_id_reused'`.
- Errors: `notFound` (no account connected / not the caller's), `conflict` (cannot take payments yet, dashboard change, wrong status), `validation` (country, currency, amount, provider-rejected values with the provider's message), `forbidden` (access policy).

## Clients, saved cards, and the client portal

| Capability | Kind | Input | Output |
|---|---|---|---|
| `listClients` | query | `{ reference?, email?, limit?, offset? }` | `{ clients }` |
| `saveClientPaymentMethod` | action | `{ client }` | `{ clientId, url, expiresAt }` (a page where the client saves a card) |
| `listClientPaymentMethods` | query | `{ clientId }` | `{ paymentMethods }` |
| `syncClientPaymentMethods` | action | `{ clientId }` | `{ paymentMethods }` (pulls them from the provider) |
| `removeClientPaymentMethod` | action | `{ paymentMethodId }` | `{ paymentMethod }` |
| `chargeSavedMethod` | action | `{ clientId, paymentMethodId?, amount? \| items?, currency, description, capture?, statementDescriptorSuffix?, metadata?, requestId? }` | `{ charge, created }` |
| `createClientPortalSession` | action | `{ clientId }` | `{ url }` (the provider's portal: cards, invoices, subscriptions) |

`chargeSavedMethod` charges without the client (no-show fees, charging after the session). If the bank wants the client present, the charge is `requires_action` with a `url` to a payment page for the same charge (and `payments.charge.actionRequired`); a decline is `failed` with `failureCode`.

## Links, subscriptions, disputes, payouts, transfers

| Capability | Kind | Input | Output |
|---|---|---|---|
| `createPaymentLink` | action | `{ description, currency, amount? \| items? \| customAmount?, options?, metadata? }` (items may have `adjustableQuantity: { minimum, maximum }`) | `{ link }` |
| `listPaymentLinks` | query | `{ active?, limit?, offset? }` | `{ links }` |
| `setPaymentLinkActive` | action | `{ linkId, active }` | `{ link }` |
| `createSubscription` | action | `{ client, currency, items: [{ name, unitAmount, interval, intervalCount?, quantity? }], trialDays?, ui?, options?, metadata?, requestId? }` | `{ subscription, created }` (`subscription.checkoutUrl`) |
| `listSubscriptions` | query | `{ status?, clientId?, limit?, offset? }` | `{ subscriptions }` |
| `getSubscription` | query | `{ subscriptionId }` | `{ subscription, invoices }` |
| `cancelSubscription` | action | `{ subscriptionId, atPeriodEnd? }` (default at period end) | `{ subscription }` |
| `resumeSubscription` | action | `{ subscriptionId }` | `{ subscription }` |
| `syncSubscription` | action | `{ subscriptionId }` | `{ subscription }` |
| `listDisputes` | query (`access.disputes`) | `{ status?, limit?, offset? }` | `{ disputes }` |
| `respondToDispute` | action (`access.disputes`) | `{ disputeId, evidence: { productDescription?, customerName?, customerEmail?, serviceDate?, refundPolicy?, cancellationPolicy?, uncategorizedText? }, submit }` | `{ dispute }` |
| `acceptDispute` | action (`access.disputes`) | `{ disputeId }` | `{ dispute }` |
| `listPayouts` | query | `{ limit?, offset? }` | `{ payouts }` |
| `getPayoutSettings` | action | `{}` | `{ settings: { schedule, canChangeSchedule, instantAvailable } }` |
| `updatePayoutSchedule` | action | `{ schedule }` (with `payouts.sellersMayChangeSchedule`; not for full-dashboard sellers) | `{ settings }` |
| `createInstantPayout` | action | `{ amount, currency, requestId? }` (with `payouts.instant`) | `{ payout }` |
| `listTransfers` | query | `{ chargeId?, limit?, offset? }` (with `transfers.enabled`) | `{ transfers }` |

Evidence is final once submitted (`submit: true`); `submit: false` saves a draft.

## Your platform's plans (`billing`)

Access: `access.billing` for changes, `access.entitlements` for reads.

| Capability | Kind | Input | Output |
|---|---|---|---|
| `listPlans` | query | `{}` | `{ plans }` (a pricing page: names, features, prices) |
| `subscribeToPlan` | action | `{ plan, price, quantity?, email?, ui?, requestId? }` | `{ subscription, created }` (`subscription.checkoutUrl`) |
| `getPlanSubscription` | query | `{}` | `{ subscription \| null, invoices, features }` |
| `changePlan` | action | `{ plan, price, quantity? }` | `{ subscription }` (prorated unless `billing.prorate: false`) |
| `cancelPlanSubscription` | action | `{ atPeriodEnd? }` | `{ subscription }` |
| `resumePlanSubscription` | action | `{}` | `{ subscription }` |
| `openBillingPortal` | action | `{}` | `{ url }` |
| `getEntitlements` | query | `{}` | `{ features }` |

Server-side helpers for your own capabilities (spread `payments.effects.billing` / `payments.effects.platform` into their `effects`):

| Helper | Use |
|---|---|
| `payments.billing.hasFeature(ctx, feature)` / `features(ctx)` | Gate your capabilities by plan |
| `payments.billing.setSeats(ctx, { quantity })` | Keep a per-seat plan in step with your member count |
| `payments.billing.recordUsage(ctx, { meter, value, identifier? })` | Meter usage (counted once per `identifier`) |
| `payments.billing.purchase(ctx, { amount \| items, currency, description, … })` | A one-off purchase billed to the caller's billing customer |
| `payments.billing.aiUsageBridge({ meter, value: 'tokens' \| 'costMicros' \| fn })` | An `onAICostRecorded` hook for `app/server.ts` |
| `payments.platform.createCharge(ctx, { … , transferGroup? })` | A charge on your platform (no seller) |
| `payments.platform.transferToSeller(ctx, { merchantAccountId, amount, currency, chargeId?, requestId? })` | Pay a seller (with `transfers.enabled`) |
| `payments.platform.reverseTransfer`, `refundCharge`, `captureCharge`, `cancelCharge`, `getCharge` | The rest of a platform charge's life |

## From the browser

Use the generated client hooks like any other capability. Redirect to `onboardingUrl`, `charge.url`, `subscription.checkoutUrl`, and portal `url`s. For embedded onboarding and dashboards, fetch `createMerchantSession` and hand `clientSecret` + `publishableKey` to the provider's component library (Stripe: `@stripe/connect-js`); for embedded payment pages, hand `charge.checkout` to the provider's embedded checkout (Stripe.js `initEmbeddedCheckout`, with `stripeAccount: checkout.accountId` when set).

## From your own capabilities

When your app decides the price (a booking, an order), call `createCharge` from a server capability so the amount is not browser-controlled:

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

Write `eventHandler` capabilities with `trigger: { event: '<name>' }`. Seller events carry `merchantAccountId`, `ownerType`, `ownerId` (null for platform charges); charge events add `chargeId`, `flow`, `amount`, `currency`, `clientId`, `billingCustomerId`.

| Event | When | Typical reaction |
|---|---|---|
| `payments.merchant.updated` | Seller status, abilities, or requirements changed | Notify the seller; unlock "request payment" when active |
| `payments.charge.created` | A charge was created (`collection`, `platformFeeAmount`) | Send the link |
| `payments.charge.authorized` | A hold succeeded (`amountCapturable`, `captureBefore`) | Capture before `captureBefore` |
| `payments.charge.actionRequired` | A saved method needs the client (`url`) | Send the client the `url` |
| `payments.charge.paid` | Client paid (`amountTotal`, `linkId`) | **Deliver / grant access / mark the order paid** |
| `payments.charge.failed` | A payment failed (`failureCode`) | Tell the seller |
| `payments.charge.expired` / `canceled` | Page expired unpaid / charge stopped | Offer a new one |
| `payments.charge.refunded` | Money returned (`amountRefunded`, `fullyRefunded`) | Revoke if fully refunded |
| `payments.refund.failed` | A refund could not complete | Tell the seller |
| `payments.dispute.opened` / `updated` / `closed` | Client disputed a charge (`status`, `evidenceDueBy`) | Alert the seller before `evidenceDueBy` |
| `payments.paymentMethod.saved` | A client saved a card (`brand`, `last4`) | Show "card on file" |
| `payments.subscription.started` / `updated` / `ended` | A seller's or plan subscription changed (`payee`, `plan`, `status`, `previousStatus`) | Grant or revoke access |
| `payments.invoice.paid` / `paymentFailed` | A subscription invoice was paid or a payment attempt failed | Receipts, dunning messages |
| `payments.transfer.created` / `reversed` | Money sent to a seller / taken back | Seller statements |
| `payments.payout.paid` / `failed` | A seller payout arrived or failed (`failureCode`) | Tell the seller |
| `payments.entitlements.updated` | A billing customer's features changed (`features`, `added`, `removed`) | Turn features on or off |

Handlers must be idempotent on their ids (events are delivered at least once). Put your own metadata (`lessonId`) on the charge and read it back with `getCharge` or `ctx.data.PaymentCharge`.

## Reading payments in app code

`ctx.data.PaymentCharge`, `ctx.data.PaymentMerchantAccount`, `ctx.data.PaymentSubscription`, etc. are normal tenant-scoped repositories (row types exported as `PaymentChargeRow`, …). Read them freely; **do not write them** — only the payments capabilities, helpers, and the webhook worker update them.
