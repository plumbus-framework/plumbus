# Stripe webhooks for @plumbus/payments

One route (`POST /payments/webhooks/stripe`) receives two Stripe **event destinations**:

| Destination | Payload | `events_from` | Events |
|---|---|---|---|
| `plumbus-payments-sellers` | snapshot, version `2026-08-26.dahlia` | `@accounts` (connected accounts) | `STRIPE_SNAPSHOT_EVENTS`: checkout.session.* (completed, async succeeded/failed, expired), refund.*, charge.refunded, charge.refund.updated, charge.dispute.* |
| `plumbus-payments-accounts` | thin | `@self` | `STRIPE_THIN_EVENTS`: v2.core.account.created/updated/closed and `[requirements]`, `[configuration.merchant]`, `[defaults]`, `[identity]` updates |

## Production / staging

```bash
plumbus payments webhooks setup --url https://api.example.com/payments/webhooks/stripe
```

- Creates both destinations (skips ones that already exist for that URL) and prints each **signing secret once**.
- Put both secrets in `STRIPE_WEBHOOK_SECRETS` (comma-separated). During a rotation, list old and new secrets until Stripe stops signing with the old one.
- Verify: `plumbus payments doctor --live --webhook-url https://api.example.com/payments/webhooks/stripe`.

Do not create these destinations by hand with different names; `doctor` looks for the names above.

## Local development with the Stripe CLI

```bash
stripe listen --latest \
  --forward-to localhost:3000/payments/webhooks/stripe \
  --forward-connect-to localhost:3000/payments/webhooks/stripe \
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated' \
  --forward-thin-to localhost:3000/payments/webhooks/stripe
```

Put the printed `whsec_…` secret in `STRIPE_WEBHOOK_SECRETS`. Platform-level events the CLI forwards (no seller account) are recorded as ignored — that is expected.

## How the route behaves

- Invalid signature / missing header → `400`, nothing recorded.
- Event from the other mode (test vs live), unrelated type, or unknown seller → `200`, recorded as `ignored` with a reason (`livemode_mismatch`, `unhandled_type`, `unknown_seller_account`, `no_seller_account`).
- Relevant event → `200`, recorded and queued; the worker re-reads Stripe and applies it. The same event delivered again → `200`, `duplicate` — unless its processing had failed; then it is queued again (resend it from the Dashboard to retry).
- Recording fails (database down) → `500`, so Stripe retries.

Inspect deliveries in the `PaymentProviderEvent` table (`status`, `ignoredReason`, `error`).
