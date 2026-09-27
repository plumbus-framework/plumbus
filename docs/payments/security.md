# Payments security

**Previous:** [testing.md](./testing.md)

| Threat | What stops it |
|---|---|
| A user acts on another seller's account | The seller is derived from `ctx.auth` (user or tenant), never from input; charges/refunds are looked up by id **and** seller; entities are tenant-scoped |
| A browser sets its own price or fee | `createCharge` takes the amount from the caller but computes the fee on the server; for fixed prices, call it from your own capability with the server-side amount |
| Forged or replayed webhooks | Stripe signature over the exact raw bytes, 300 s timestamp tolerance, unique ledger per event id |
| Test events hitting production (or the reverse) | Events whose `livemode` differs from the key's mode are ignored |
| Delivering goods on a faked redirect | Docs and instructions: deliver only on `payments.charge.paid`, which comes from a fresh Stripe read |
| Anyone calling the internal webhook capabilities over HTTP | `recordProviderEvent`, `processProviderEvent`, `applyProviderState` require the `system` role or the `payments-webhook` service account (a `serviceAccounts` list alone would not exclude other users) |
| Double charges from double clicks | `requestId` returns the existing charge/refund; Stripe idempotency keys derive from local ids |
| Spoofed Plumbus metadata | Input metadata keys starting with `plumbus_` are rejected |
| Personal data in logs and ledgers | Client email/name fields are classified `personal` and masked in logs; webhook bodies are not stored unless `webhooks.storePayload` |
| Holding a DB transaction during Stripe calls | Capabilities that call Stripe declare `effects.external` (non-transactional); state is written in a separate short transaction |
| Leaked keys at build time | Secrets are read on first use (functions), so `plumbus generate`/migrations never need them; `doctor` flags test keys in production |

Card data never reaches your servers: clients pay on Stripe-hosted Checkout, and sellers onboard on Stripe-hosted or Stripe-embedded pages.
