# `payments-connect-app` — test app for Plumbus payments

A real Plumbus app (a small tutoring marketplace) wired to `@plumbus/payments` and
`@plumbus/payments-stripe` exactly as the package instructions describe, plus the
infrastructure to test every payments feature end to end:

| Piece | Where | What it is |
|---|---|---|
| The app | `app/` | `app/payments/index.ts` (`createPayments` + `stripeProvider`, every feature on: tutors on the full dashboard with direct charges and on Express with destination charges, invoices, subscriptions, payouts, transfers, and school plans with seats, an AI-usage meter, and features), the payments collections exported in one line each, a `Lesson` entity, lesson capabilities that call `payments.createCharge` with a server-side price, event handlers for `payments.charge.paid`, `payments.charge.refunded`, `payments.dispute.opened`, and `app/capabilities/school.ts`: a group class the platform charges for and splits between tutors (`payments.platform`), and AI-tutor usage, a feature gate, and seats (`payments.billing`) |
| Stripe simulator | `stripe-sim/server.mjs` | A stateful local Stripe for everything the adapter calls: v2 accounts (merchant and recipient configurations), account links, event destinations; Checkout (payment, subscription, setup; hosted and embedded), PaymentIntents, refunds, disputes, payment methods, billing portal, products, prices, entitlements, meters, subscriptions, invoices, payment links, transfers, payouts, Balance Settings. Objects live on a seller's account or the platform; it enforces Stripe's rules (Connect, capabilities, minimums, expiry window, refund and capture limits, lookup keys, weekday payouts), honours `Idempotency-Key`, and delivers **signed** snapshot events (from `@self` and `@accounts`) and thin events to the destinations the app creates. Control API under `/_sim` (including bank-debit payments that stay processing until `/_sim/payments/:pi/settle`), browser pages under `/connect`, `/pay`, `/buy`, `/invoice`, `/portal`, `/express` |
| End-to-end runner | `scripts/e2e.mjs` | Private Postgres → migrations → simulator → `plumbus dev` (API + worker + outbox) → `plumbus payments webhooks setup` → `catalog check` (fails) → `catalog sync` (twice) → `catalog check` (passes) → `doctor --live` → scenarios over HTTP |
| Scenarios | `scenarios/index.mjs` | 28 scenarios, one or more per payments feature |
| Manual run | `scripts/dev.mjs` | Same stack, kept running, with a tutor token and ready-to-paste commands; `--stripe` uses real Stripe test mode |

Unlike [`../payments-stripe-smoke`](../payments-stripe-smoke/) (in-memory, one process, no database), this runs
the real Plumbus runtime: discovery of re-exported capabilities, Drizzle migrations
(64-bit amount columns), the transactional outbox, the worker's event handlers,
the webhook route inside `createServer`, JWT auth, and tenant-scoped Postgres
repositories.

It is not part of the pnpm workspace and installs nothing: `scripts/link.mjs`
symlinks the built packages into `node_modules/`.

## Requirements

- `pnpm build` at the repo root (the app uses the packages' `dist/`).
- Docker (the runner starts `postgres:16-alpine` on a random localhost port and removes it afterwards). Or set `E2E_DB_HOST`, `E2E_DB_PORT`, `E2E_DB_USER`, `E2E_DB_PASSWORD` to use an existing Postgres; a fresh database is created per run.

## Run the end-to-end suite

```bash
cd examples/payments-connect-app
node scripts/e2e.mjs            # everything (~60 s)
node scripts/e2e.mjs --only refunds --verbose   # up to one scenario, with simulator + app logs on failure
node scripts/e2e.mjs --keep     # leave the stack running afterwards
```

| Scenario | Proves |
|---|---|
| `webhook-destinations` | `webhooks setup` creates both destinations (snapshot from the platform and sellers); `catalog sync` ran; `doctor --live` passes |
| `onboard-full` | Onboarding link → finish onboarding → thin v2 account events → seller `active`, direct charges, merchant + recipient configurations |
| `onboard-express` | Express seller: destination charges, a recipient-only account, login link; the dashboard is permanent (409) |
| `lesson-paid` | Server-priced lesson → payment page on the tutor's account → `checkout.session.completed` → charge paid, 5% cut, lesson handler ran once |
| `duplicate-webhook` | Stripe redelivers twice: one ledger row, lesson handler still ran once |
| `destination-charges` | Express tutor: the page and the student live on the platform, `transfer_data` pays the tutor, fee function gives 8% + 30 |
| `refunds` | Partial and full refunds with `requestId` idempotency; racing refund webhooks leave one row each; over-refund refused |
| `destination-refund` | A destination refund is made on the platform with `reverse_transfer` and `refund_application_fee`, and reaches the charge by a platform webhook |
| `dispute` | Dispute webhook flags the lesson and records the dispute |
| `dispute-response` | Evidence submitted (policy text in the disclosure field); the dispute takes no more answers (409) |
| `expired-link` | `checkout.session.expired` moves the charge to expired |
| `line-items-and-options` | Line items, a promotion code, and Stripe Tax: discount and tax recorded, fee on the items |
| `custom-amount` | The client chooses the amount; the paid amount becomes the charge amount |
| `embedded-checkout` | `ui: 'embedded'` returns `checkout.clientSecret`, the publishable key, and the tutor's account; paying it marks the charge paid |
| `holds` | Manual capture: `authorized` → partial capture with the fee recomputed; a second hold released at Stripe |
| `saved-cards` | A card-saving page → the card by webhook → off-session charge (idempotent) → a bank that wants the client → recovery page paid → client portal → card removed at Stripe |
| `invoices` | An emailed invoice with the tutor's fee, paid on its own page; an unpaid one voided |
| `payment-links` | Two payments through one adjustable-quantity link become two charges naming the link; a disabled link refuses payments |
| `client-subscriptions` | Subscription checkout with the platform percentage; a failed renewal → `past_due`; paid again → `active`; cancel and resume |
| `payout-timing` | The app's weekly schedule on a new Express tutor; a schedule change; an instant payout; payout webhooks (paid, failed); full-dashboard tutors refused (409) |
| `separate-charges` | The school sells a group class on the platform; the paid-class handler transfers each tutor's share (`source_transaction`, `transfer_group`); tutors see their transfer |
| `platform-billing` | No plan → AI tutor refused; a school subscribes to a per-seat plan → entitlements by webhook → AI tutor allowed; seats 3 → 5 at Stripe; the AI meter billed; billing portal; another school has no plan |
| `usage-billing` | AI tutor usage metered on the school's billing customer, once per session |
| `plan-change` | Moving to the cheaper plan removes the AI tutor entitlement; cancel at period end |
| `stripe-errors` | Stripe's minimum-amount error reaches the caller as a 400; no local row left behind |
| `tenant-isolation` | Another tenant — and another seller in the same tenant — get 404 for someone else's charge |
| `access-control` | Non-sellers get 403; tutors cannot change the school plan; internal webhook capabilities are closed to users |
| `webhook-security` | Forged signature → 400, nothing recorded |

## Explore by hand

```bash
node scripts/dev.mjs            # simulator: open the printed links in a browser
```

With real Stripe **test mode** instead of the simulator:

```bash
# terminal 1 — forward Stripe events to the port you pass as PORT below
stripe listen --latest \
  --forward-to localhost:4100/payments/webhooks/stripe \
  --forward-connect-to localhost:4100/payments/webhooks/stripe \
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated,v2.core.account[configuration.recipient].updated,v2.core.account[configuration.recipient].capability_status_updated' \
  --forward-thin-to localhost:4100/payments/webhooks/stripe

# terminal 2
PORT=4100 STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRETS=whsec_… node scripts/dev.mjs --stripe
```

Live keys are refused.

## Adding a feature

1. **Packages:** add the option to `createPayments` (and `docs/payments/options.md` — a test enforces it), the provider-contract method, and the Stripe adapter call, with unit tests.
2. **Simulator:** implement the new Stripe endpoints and webhooks in `stripe-sim/server.mjs`. Unknown endpoints answer 404 with "the Stripe simulator does not implement … yet", so a missing one is obvious.
3. **App:** use the feature in `app/` the way a consumer would.
4. **Scenario:** add a `run(t)` to `scenarios/index.mjs` that drives it through the API and the simulator's `/_sim` control endpoints.
5. `node scripts/e2e.mjs` — and, before release, once against Stripe test mode with `scripts/dev.mjs --stripe`.
