# `payments-connect-app` — test app for Plumbus payments

A real Plumbus app (a small tutoring marketplace) wired to `@plumbus/payments` and
`@plumbus/payments-stripe` exactly as the package instructions describe, plus the
infrastructure to test it — and every later payments phase — end to end:

| Piece | Where | What it is |
|---|---|---|
| The app | `app/` | `app/payments/index.ts` (`createPayments` + `stripeProvider`), re-exported payments capabilities/entities/events, a `Lesson` entity, lesson capabilities that call `payments.createCharge` with a server-side price, and event handlers for `payments.charge.paid`, `payments.charge.refunded`, `payments.dispute.opened` |
| Stripe simulator | `stripe-sim/server.mjs` | A stateful local Stripe: v2 accounts, account links, event destinations; v1 account sessions, login links, customers, Checkout, refunds, disputes. Enforces Stripe's Connect rules, honours `Idempotency-Key`, and delivers **signed** snapshot and thin webhooks to the destinations the app creates. Control API under `/_sim`, browser pages under `/connect`, `/pay`, `/express` |
| End-to-end runner | `scripts/e2e.mjs` | Private Postgres → migrations → simulator → `plumbus dev` (API + worker + outbox) → `plumbus payments webhooks setup` + `doctor --live` → scenarios over HTTP |
| Scenarios | `scenarios/index.mjs` | 13 phase-1 scenarios, and the later phases listed as `planned` with what each needs |
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
node scripts/e2e.mjs            # everything (~25 s)
node scripts/e2e.mjs --only refunds --verbose   # up to one scenario, with simulator + app logs on failure
node scripts/e2e.mjs --keep     # leave the stack running afterwards
```

| Scenario | Proves |
|---|---|
| `webhook-destinations` | `plumbus payments webhooks setup` creates both destinations; `doctor --live` passes |
| `onboard-full` | Onboarding link → finish onboarding → thin v2 account event → worker → seller `active` |
| `onboard-express` | A seller picks Express (platform fees + losses); login link; dashboard is permanent (409) |
| `lesson-paid` | Server-priced lesson → payment link → `checkout.session.completed` → charge paid, 5% cut, lesson handler ran once |
| `duplicate-webhook` | Stripe redelivers twice: one ledger row, lesson handler still ran once |
| `express-fee` | Fee function charges Express sellers 8% + 30 |
| `refunds` | Partial and full refunds with `requestId` idempotency; refund webhooks racing the API response leave exactly one row each; over-refund refused |
| `dispute` | Dispute webhook flags the lesson and records the dispute |
| `expired-link` | `checkout.session.expired` moves the charge to expired |
| `stripe-errors` | Stripe's minimum-amount error reaches the caller as a 400; no local row left behind |
| `tenant-isolation` | Another tenant — and another seller in the same tenant — get 404 for someone else's charge |
| `access-control` | Non-sellers get 403; internal webhook capabilities are closed to users |
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
  --thin-events 'v2.core.account.created,v2.core.account.updated,v2.core.account.closed,v2.core.account[requirements].updated,v2.core.account[configuration.merchant].updated,v2.core.account[configuration.merchant].capability_status_updated' \
  --forward-thin-to localhost:4100/payments/webhooks/stripe

# terminal 2
PORT=4100 STRIPE_SECRET_KEY=sk_test_… STRIPE_WEBHOOK_SECRETS=whsec_… node scripts/dev.mjs --stripe
```

Live keys are refused.

## Adding a later phase

Each planned phase (destination and separate charges, payout timing, payment links, invoices, embedded Checkout, client subscriptions, client portal, platform billing, usage billing, Stripe Tax) is listed in `scenarios/index.mjs` with the Stripe APIs it needs, and printed as `PLAN` on every run. To build one:

1. **Packages:** add the option to `createPayments` (and `docs/payments/options.md` — a test enforces it), the provider-contract method, and the Stripe adapter call, with unit tests.
2. **Simulator:** implement the new Stripe endpoints and webhooks in `stripe-sim/server.mjs`. Unknown endpoints answer 404 with "the Stripe simulator does not implement … yet", so a missing one is obvious.
3. **App:** use the feature in `app/` the way a consumer would.
4. **Scenario:** replace the `planned` entry with a `run(t)` that drives it through the API and the simulator's `/_sim` control endpoints.
5. `node scripts/e2e.mjs` — and, before release, once against Stripe test mode with `scripts/dev.mjs --stripe`.

## Simulator control API

| Endpoint | Effect (and webhook sent) |
|---|---|
| `POST /_sim/accounts/:id/complete-onboarding` | Payments + payouts active (`v2.core.account[configuration.merchant].capability_status_updated`, `[requirements].updated`) |
| `POST /_sim/accounts/:id/restrict` | Requirement past due (`[requirements].updated`) |
| `POST /_sim/accounts/:id/close` | Account closed (`v2.core.account.closed`) |
| `POST /_sim/checkout/:id/pay` | Session paid, PaymentIntent created (`checkout.session.completed`) |
| `POST /_sim/checkout/:id/expire` | Session expired (`checkout.session.expired`) |
| `POST /_sim/refunds/:id/settle` `{ status: 'succeeded' \| 'failed' }` | `refund.updated` / `refund.failed` |
| `POST /_sim/payments/:pi/dispute` `{ reason?, amount? }` | `charge.dispute.created` |
| `POST /_sim/disputes/:id/status` `{ status }` | `charge.dispute.updated` / `.closed` |
| `POST /_sim/events/:id/redeliver` | Sends a stored event again |
| `GET /_sim/state`, `GET /_sim/deliveries` | Everything the simulator holds / every delivery and its HTTP status |

The simulator signs with fixed secrets (`SIM_SECRETS` in `stripe-sim/server.mjs`) so the app can start before its destinations exist.
