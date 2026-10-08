# @plumbus/ai-decision-typesafe

> **TypeSafe/Jev decisions for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** TypeSafe/Jev provider for typed choices, scores, and probabilities, called through `ctx.ai.decide()` / `ctx.ai.classify()` with **input pricing** of the actual response model.

[![npm](https://img.shields.io/npm/v/@plumbus/ai-decision-typesafe.svg)](https://www.npmjs.com/package/@plumbus/ai-decision-typesafe)
[![license](https://img.shields.io/npm/l/@plumbus/ai-decision-typesafe.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai.decide()` (core 0.7.3+) and `ctx.ai.classify()` (core 0.7.4+) against decision adapters registered under `decisions.providers`, separately from text-generation providers.

`@plumbus/ai-decision-typesafe` is the **TypeSafe/Jev System One adapter**. It sends the shared [`@plumbus/ai-decision`](../ai-decision/) contract to TypeSafe's `/systemone` endpoint, checks the answers with the shared validator, and prices the actual response model. It calls the documented HTTP endpoint directly through the shared transport; there is no vendor SDK to install.

## Why?

Typed decision models answer bounded questions (one option from a list, a level on an ordered scale, a probability) instead of generating text, so Plumbus registers them apart from text-generation providers. Each vendor ships as its own optional package:

- Apps install only the provider they use; no provider depends on another.
- The contract, validation, and transport live in `@plumbus/ai-decision`, so every provider takes the same request and core checks every result the same way.

This package gives apps that use TypeSafe's hosted Jev models a registered decision provider with per-call cost rows.

## What you get

| Surface | What it does |
|---|---|
| `createTypeSafeDecisionAdapter()` | `DecisionProviderAdapter` (provider name `typesafe`) for `decisions.providers` in `app/server.ts`. |
| System One mapping | Shared questions to the System One wire format (`probability` maps to `noul`); answers validated by `@plumbus/ai-decision`. |
| Input pricing | Bundled `jev-1.13.0` rate (`TypeSafeDecisionInputRates`), `inputRates` overrides, priced by the actual response model. |
| Billed failures | Malformed answers keep the model, usage, and known cost, so core records the billed failure. |
| Bounded HTTP | Shared transport: deadlines, cancellation, retries on 429 and transient 5xx with `Retry-After`, redirects disabled. |
| Re-exports | `DecisionProviderError` and the protocol types `DecisionProviderAdapter`, `DecisionQuestions`, `DecisionRequest`, `DecisionResult`. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Text responses, structured generation, or embeddings | Built-in text providers in `@plumbus/core` |
| Labels from a generative model | `ctx.ai.classify()` with a text provider (the default) |
| Hosted typed decisions from TypeSafe/Jev | **`@plumbus/ai-decision-typesafe`** (this package) |
| Typed decisions on your own servers, no hosted API | [`@plumbus/ai-decision-laya`](../ai-decision-laya/) |
| Hosted typed decisions from OpenAI (public beta) | [`@plumbus/ai-decision-openai`](../ai-decision-openai/) |
| Named contracts, answer types, or your own adapter | [`@plumbus/ai-decision`](../ai-decision/) |

## Status

Optional decision provider, version `0.2.3` (version-locked **`0.2.x`**); required peer `@plumbus/core` exactly **`0.7.x`**; Node.js 20.6+. **Runtime floor:** `ctx.ai.decide()` needs `@plumbus/core` **≥ 0.7.3** and `ctx.ai.classify({ provider })` needs **≥ 0.7.4**; agent wiring **v17** (core 0.7.4+) links these instructions. Depends on `@plumbus/ai-decision` `~0.2.3`. Install alone is not enough until the adapter is registered under `decisions.providers`.

Not included: vendor model catalogs, automatic environment provider discovery, and dedicated decision CLI commands.

Release notes: [changelog](./CHANGELOG.md) and [version/upgrade guide](../../docs/upgrading-classification.md).

## Install

```bash
pnpm add @plumbus/ai-decision-typesafe
```

Install explicitly with `pnpm add @plumbus/ai-decision-typesafe`. Provider packages install
`@plumbus/ai-decision` transitively. There is no dependency on the other decision providers.

Peer (copy literally): `@plumbus/core` `0.7.x`. See `node_modules/@plumbus/core/instructions/peer-dependencies.md`.

If agent wiring predates the decision provider instructions, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

## Quick start

Core `0.7.3+` provides `ctx.ai.decide()` with shared validation, security, budgets,
and per-call cost recording. Define named contracts with `defineDecision` from
`@plumbus/ai-decision`, and export explicit provider registration as `decisions`
from `app/server.ts` for API and worker processes. See the
[decision integration guide](../../docs/ai/decision-providers.md#application-integration-and-cost-recording).

```ts
// app/server.ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

export const decisions = {
  providers: {
    typesafe: createTypeSafeDecisionAdapter({ apiKey: process.env.TYPESAFE_API_KEY ?? '' }),
  },
  defaultProvider: 'typesafe',
};
```

Then, inside a capability handler:

```ts
const result = await ctx.ai.decide({
  state: { message: input.message },
  questions: {
    refund: { type: 'probability', instructions: 'Does the customer request a refund?' },
  },
  signal: ctx.signal,
});
result.answers.refund.probability; // P(true), not a boolean
```

Core **0.7.4+** also supports `ctx.ai.classify({ text, labels, provider, model, threshold })`
for generative or decision models. Start with
`node_modules/@plumbus/core/instructions/ai-classification.md` for registration,
model defaults, multi-label semantics, and cost recording.

### Infrastructure / smoke testing

Direct adapter calls remain useful for infrastructure tests and do not record costs
in core. Keep these adapters separate from the text-generation provider registry.

```ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

const adapter = createTypeSafeDecisionAdapter({ apiKey: process.env.TYPESAFE_API_KEY ?? '' });
const result = await adapter.decide({
  state: 'Please refund the duplicate charge.',
  questions: { refund: { type: 'probability', instructions: 'Is a refund requested?' } },
});
console.log(result.answers.refund.probability);
```

Business logic belongs in Plumbus capabilities/flows and `ctx.*`. These examples
exercise the provider protocol only; they do not provide the core execution lifecycle.

## Pricing (important)

The adapter prices the **actual response model**, not the `jev-latest` alias, from input tokens. The bundled `jev-1.13.0` rate is $0.042 per million input tokens, with free output, verified against [TypeSafe's model documentation](https://docs.typesafe.ai/models) on 2026-09-22. An `inputRates` entry such as `{ 'model-id': rate }` overrides input USD per million tokens.

Unknown response models return `cost: null`; they are not free. Core records such calls as unpriced, and when a dollar budget is configured, unpriced prior calls block further calls.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | TypeSafe API key; keep it on the server |
| `model` | `jev-latest` | Overridden by per-call `model`, then a `defineDecision` contract's `model`, then `decisions.defaultModel` |
| `baseUrl` | `https://api.typesafe.ai/v1` | API prefix; the adapter appends `/systemone` |
| `inputRates` | bundled `jev-1.13.0` rate | Input USD per million tokens, keyed by response model ID |
| `timeoutMs` | `30000` | Whole-call deadline, at most five minutes |
| `maxRetries` | `2` | Retries HTTP 429 and transient 5xx only (0–5) |
| `fetch` | `globalThis.fetch` | Injected HTTP implementation for tests |

## Key gotchas

- **Register under `decisions`, not as a text provider.** Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Provider names must be distinct across the text and decision registries.
- **Direct adapter calls skip core.** They do not enforce core's PII checks, budgets, identity attribution, action confirmation, or ledger hooks. Use `ctx.ai.decide()` / `ctx.ai.classify()` in capabilities and flows.
- **Unknown cost is `null`, not free.** Only `jev-1.13.0` is bundled; another response model stays unpriced until you add its `inputRates` entry.
- **Failed calls are recorded.** Core records one row per dispatched call, including failed and cancelled calls; answer-validation failures keep the known model, usage, and cost because the call may already have been billed.
- **Probabilities are not permissions.** A probability is P(true), not a boolean, and a high confidence value is not authorization or proof of correctness. Validate thresholds on the actual task, model, and language.
- **Retries can repeat cost.** The transport retries HTTP 429, 500, 502, 503, 504, and 529 (two retries by default, honoring `Retry-After`); repeated requests can still incur cost, with no exactly-once guarantee.
- **Keys are used as given.** API keys must be printable ASCII without whitespace; credentials are never trimmed.
- **The local smoke app does not reach TypeSafe.** `examples/ai-decision-smoke` runs this adapter against the local Laya reference service; it does not verify hosted TypeSafe authentication or billing.

## Documentation / Agent recipes

- **Concept docs:** read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
  for the complete contract, failure behavior, pricing, deployment, and live test environment.
  Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).
- **Classification recipe** (after install): `node_modules/@plumbus/core/instructions/ai-classification.md`
- **Live smoke (monorepo):** [`examples/ai-decision-smoke`](../../examples/ai-decision-smoke) runs this adapter and Laya against a local Laya server; `scripts/smoke.mjs` sends one live request when `PLUMBUS_LIVE_DECISION_TESTS=1` and `TYPESAFE_API_KEY` are set (a repository tool, not in the npm package).
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/ai-decision-typesafe/instructions/`):
  - [Instructions index](instructions/README.md)
  - [Framework boundary and usage](instructions/framework.md)
  - [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision-typesafe` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Shared contracts** — [`@plumbus/ai-decision`](../ai-decision/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
