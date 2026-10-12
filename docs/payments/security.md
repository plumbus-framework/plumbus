# Payments security

**Previous:** [testing.md](./testing.md)

| Threat | What stops it |
|---|---|
| A user acts on another seller's account | The seller is derived from `ctx.auth` (user or tenant), never from input; charges, refunds, clients, links, subscriptions, and payouts are looked up by id **and** seller; entities are tenant-scoped |
| A webhook applied to the wrong tenant | Seller events are routed by their Stripe account; platform events by the tenant stamped in the object's metadata (or its local row); each change applies only to a row that lives on the account the change was read from |
| Using a paid feature without paying | `payments.billing.hasFeature` reads entitlements that only webhooks (from a fresh Stripe read) write; plan changes need `access.billing` |
| A browser sets its own price or fee | `createCharge` takes the amount from the caller but computes the fee on the server; for fixed prices, call it from your own capability with the server-side amount |
| Forged or replayed webhooks | Stripe signature over the exact raw bytes, 300 s timestamp tolerance, unique ledger per event id |
| Test events hitting production (or the reverse) | Events whose `livemode` differs from the key's mode are ignored |
| Delivering goods on a faked redirect | Docs and instructions: deliver only on `payments.charge.paid`, which comes from a fresh Stripe read |
| Anyone calling the internal webhook capabilities over HTTP | `recordProviderEvent`, `processProviderEvent`, `applyProviderState` require the `system` role or the `payments-webhook` service account (a `serviceAccounts` list alone would not exclude other users) |
| Double charges from double clicks | `requestId` returns the existing charge/refund/transfer/payout, and reusing it for a different request is a `conflict`; Stripe idempotency keys derive from local ids, and a refund's id derives from its `requestId`, so a retry after a lost response repeats the very same Stripe request. Usage is counted once per `identifier` |
| A seller marking a charge paid with a cheaper checkout of their own | A session is applied to a charge only if it is that charge's session and has its amount and currency; refunds and disputes must match the charge's payment |
| Spoofed Plumbus metadata | Input metadata keys starting with `plumbus_` are rejected |
| Personal data in logs and ledgers | Client email/name fields are classified `personal` and masked in logs; webhook bodies are not stored unless `webhooks.storePayload` |
| Holding a DB transaction during Stripe calls | Capabilities that call Stripe declare `effects.external` (non-transactional); state is written in a separate short transaction |
| Leaked keys at build time | Secrets are read on first use (functions), so `plumbus generate`/migrations never need them; `doctor` flags test keys in production |

Card data never reaches your servers: clients pay on Stripe-hosted or Stripe-embedded Checkout, save cards on Stripe's pages, and sellers onboard on Stripe-hosted or Stripe-embedded pages. Saved cards are stored at Stripe; your rows keep only the brand, last four digits, and expiry.
