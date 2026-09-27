# Payments webhooks

**Previous:** [stripe.md](./stripe.md) · **Next:** [testing.md](./testing.md)

## Pipeline

```
Stripe ──POST──▶ /payments/webhooks/stripe (API process)
                 1. keep raw bytes (own Fastify plugin; JSON elsewhere untouched)
                 2. verify Stripe-Signature against every configured secret
                 3. ignore other mode / unrelated type / unknown seller (recorded, 200)
                 4. find the seller across tenants (service account, only cross-tenant read)
                 5. recordProviderEvent: ledger row + payments.provider.eventReceived, one transaction
                 6. 200
      worker ──▶ processProviderEvent (eventHandler, outside any transaction)
                 7. re-read Stripe for the objects the event names (fetch-on-event)
                 8. invoke applyProviderState: update local rows + emit payments.* events, one transaction
```

Why this shape:

- **Fast answers.** Stripe gets `200` as soon as the event is stored; slow work happens in the worker, and Stripe's retries (for up to three days) stay harmless.
- **Duplicates.** The ledger is unique on (provider, event id); a redelivery is answered `200` and does nothing.
- **Out of order.** The worker never trusts the event body; it reads the current object from Stripe. Snapshots older than what's stored are skipped (`syncedAt`), charge statuses never move backwards (open → processing → paid/failed/expired), and refunded amounts never shrink.
- **Tenant safety.** The seller lookup maps Stripe's account id to exactly one `PaymentMerchantAccount`; everything after it runs tenant-scoped as that seller's tenant.
- **Webhooks that beat the API response.** `createCharge` and `refundCharge` save their row (with a `pending:` placeholder provider id) *before* calling Stripe, and Stripe objects carry that row's id (`client_reference_id`, `plumbus_refund_id`). A webhook that arrives before the call returns updates that row; the capability then keeps the webhook's newer state. If Stripe rejects the call, the row is removed.

## Destinations

| Name | Payload | From | Events |
|---|---|---|---|
| `plumbus-payments-sellers` | snapshot (`2026-08-26.dahlia`) | `@accounts` | checkout.session.completed / async_payment_succeeded / async_payment_failed / expired, charge.refunded, charge.refund.updated, refund.created / updated / failed, charge.dispute.created / updated / closed / funds_withdrawn / funds_reinstated |
| `plumbus-payments-accounts` | thin | `@self` | v2.core.account.created / updated / closed, v2.core.account[requirements].updated, [configuration.merchant].updated, [configuration.merchant].capability_status_updated, [defaults].updated, [identity].updated |

`plumbus payments webhooks setup --url …` creates both (idempotently by name + URL) and prints each signing secret once. Thin events carry only an id; snapshot events carry an object, which the worker ignores in favour of a fresh read.

## The ledger (`PaymentProviderEvent`)

| Column | Meaning |
|---|---|
| `status` | `received` (queued) → `processed`, or `ignored`, or `failed` (the worker's Stripe read failed; the worker retries) |
| `ignoredReason` | `livemode_mismatch`, `unhandled_type`, `no_seller_account`, `unknown_seller_account` |
| `error` | last worker error |
| `payload` | event body, only with `webhooks.storePayload` |

Retention: 90 days. Not tenant-scoped (some events belong to no seller); only the payments service account touches it.

## Local development

```bash
stripe listen --latest \
  --forward-to localhost:3000/payments/webhooks/stripe \
  --forward-connect-to localhost:3000/payments/webhooks/stripe \
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated' \
  --forward-thin-to localhost:3000/payments/webhooks/stripe
```

Use the printed `whsec_…` as `STRIPE_WEBHOOK_SECRETS`. `--latest` renders snapshot events in the newest API version, matching the SDK. Platform events the CLI also forwards are recorded as ignored (`no_seller_account`).

## Responses

| Situation | Status |
|---|---|
| Missing or invalid signature, stale timestamp (> 300 s) | 400 |
| Body over `webhooks.bodyLimitBytes` | 413 |
| Recorded, ignored, or duplicate | 200 |
| Recording failed | 500 (Stripe retries) |
