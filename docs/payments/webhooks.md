# Payments webhooks

**Previous:** [stripe.md](./stripe.md) · **Next:** [testing.md](./testing.md)

## Pipeline

```
Stripe ──POST──▶ /payments/webhooks/stripe (API process)
                 1. keep raw bytes (own Fastify plugin; JSON elsewhere untouched)
                 2. verify Stripe-Signature against every configured secret
                 3. ignore other mode / unrelated type / unknown seller or object (recorded, 200)
                 4. find the tenant across tenants (service account, only cross-tenant read):
                    a seller's event → that seller's row; a platform event → its metadata or local rows
                 5. recordProviderEvent: ledger row + payments.provider.eventReceived, one transaction
                 6. 200
      worker ──▶ processProviderEvent (eventHandler, outside any transaction)
                 7. re-read Stripe for the objects the event names (fetch-on-event)
                 8. invoke applyProviderState: update local rows + emit payments.* events, one transaction
```

Why this shape:

- **Fast answers.** Stripe gets `200` as soon as the event is stored; slow work happens in the worker, and Stripe's retries (for up to three days) stay harmless.
- **Duplicates.** The ledger is unique on (provider, event id); a redelivery is answered `200` and does nothing. The exception is an event whose processing failed (`status: failed`, e.g. after the worker gave up): a redelivery queues it again, so resending it from the Stripe Dashboard retries it.
- **Out of order.** The worker never trusts the event body; it reads the current object from Stripe. Snapshots older than what's stored are skipped (`syncedAt`), and charge statuses never move backwards (open → processing → paid/failed/expired). A charge's refunded amount follows Stripe: it goes back down when a refund fails after succeeding.
- **Concurrent workers.** Each change is written only if the row still holds the values it was decided from (compare-and-set); a worker that loses re-reads and sees no transition. Two events about one payment processed at once emit `payments.charge.paid` once.
- **Payments that only look like ours.** A seller with a full dashboard can create their own Checkout Session carrying one of your charge ids. A session is applied only if it is the charge's own session (or the charge still awaits one) and has the same amount and currency; refunds and disputes must match the charge's payment.
- **Tenant safety.** A seller's event is routed by its Stripe account id to exactly one `PaymentMerchantAccount`. An event from your platform's own account (destination and platform charges, transfers, your plans) names no seller: it is routed by the `plumbus_tenant_id` this package stamps into every Stripe object's metadata, or else by the local row of the customer, payment, or subscription it concerns. Everything after that runs tenant-scoped as that tenant, and each change applies only to a row that lives on the account the change was read from (a seller's objects on their account, destination and platform objects on the platform).
- **Collections keep their provider object.** A charge's provider id is its payment page, its invoice, or (for a saved card charged off-session) its payment; an event about the payment behind a page or an invoice is resolved to that page or invoice, so the charge never changes identity.
- **Webhooks that beat the API response.** `createCharge` and `refundCharge` save their row (with a `pending:` placeholder provider id) *before* calling Stripe, and Stripe objects carry that row's id (`client_reference_id`, `plumbus_refund_id`). A webhook that arrives before the call returns updates that row; the capability then keeps the webhook's newer state. The row's `syncedAt` is the time the call *started*, so state a worker reads while the call is in flight is never taken for older. If Stripe rejects the call, the row is removed. If the process dies before the call completes, the row is settled one of three ways: Stripe did get the call, and its webhook fills the row in as usual; the caller retries with the same `requestId`, which finishes it; or, for a refund still waiting 15 minutes later, the next `refundCharge` on that charge asks Stripe for it (by the row id in its metadata), then keeps it if Stripe has it and removes it if not. So a refund that never happened cannot hold part of the charge.

## Destinations

| Name | Payload | From | Events |
|---|---|---|---|
| `plumbus-payments-sellers` | snapshot (`2026-08-26.dahlia`) | `@self`, `@accounts` | checkout.session.completed / async_payment_succeeded / async_payment_failed / expired; payment_intent.succeeded / amount_capturable_updated / payment_failed / processing / requires_action / canceled; charge.refunded, charge.refund.updated, refund.created / updated / failed; charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated; payment_method.attached / updated / detached; customer.subscription.created / updated / deleted / paused / resumed; invoice.finalized / paid / payment_failed / voided / marked_uncollectible; transfer.created / updated / reversed; payout.created / updated / paid / failed / canceled; entitlements.active_entitlement_summary.updated |
| `plumbus-payments-accounts` | thin | `@self` | v2.core.account.created / updated / closed, v2.core.account[requirements].updated, [configuration.merchant].updated / capability_status_updated, [configuration.recipient].updated / capability_status_updated, [defaults].updated, [identity].updated |

**A platform without sellers** (only `billing`) has no connected accounts and needs only the first destination, taking events from `@self` alone and without the `transfer.*` and `payout.*` events; there is no thin destination and no Connect requirement, and one signing secret is enough. `webhooks setup` and `doctor --live` follow the config.

`plumbus payments webhooks setup --url …` creates what the config needs (idempotently by name + URL) and prints each signing secret once. Run it again after upgrading: it adds the events a newer release needs to the existing destinations. A snapshot destination made by an earlier release takes events only from `@accounts`; Stripe cannot change a destination's sources, so setup makes a new one (store its secret) and `doctor --live` names the old one to delete. Thin events carry only an id; snapshot events carry an object, which the worker ignores in favour of a fresh read.

## The ledger (`PaymentProviderEvent`)

| Column | Meaning |
|---|---|
| `status` | `received` (queued) → `processed`, or `ignored`, or `failed` (reading Stripe or applying the result failed; the worker retries, and a redelivery queues it again) |
| `ignoredReason` | `livemode_mismatch`, `unhandled_type`, `unknown_seller_account` (a seller's event for an account the app does not know), `unknown_platform_object` (a platform event with no tenant in its metadata and no matching local row) |
| `error` | last worker error |
| `payload` | event body, only with `webhooks.storePayload` |

Retention: 90 days. Not tenant-scoped (some events belong to no seller); only the payments service account touches it.

## Local development

```bash
stripe listen --latest \
  --forward-to localhost:3000/payments/webhooks/stripe \
  --forward-connect-to localhost:3000/payments/webhooks/stripe \
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated,v2.core.account[configuration.recipient].updated,v2.core.account[configuration.recipient].capability_status_updated' \
  --forward-thin-to localhost:3000/payments/webhooks/stripe
```

Use the printed `whsec_…` as `STRIPE_WEBHOOK_SECRETS`. `--latest` renders snapshot events in the newest API version, matching the SDK. `--forward-to` carries your platform's own events (destination charges, plans, transfers); objects the app did not create are recorded as ignored.

## Responses

| Situation | Status |
|---|---|
| Missing or invalid signature, stale timestamp (> 300 s) | 400 |
| Body over `webhooks.bodyLimitBytes` | 413 |
| Recorded, ignored, or duplicate | 200 |
| Recording failed | 500 (Stripe retries) |
