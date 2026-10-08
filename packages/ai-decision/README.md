# @plumbus/ai-decision

> **Typed decisions for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** Shared decision contracts, runtime validation, structured errors, and HTTP transport for the TypeSafe/Jev, Laya, and OpenAI Decisions providers and for `ctx.ai.decide()` / `ctx.ai.classify()`.

[![npm](https://img.shields.io/npm/v/@plumbus/ai-decision.svg)](https://www.npmjs.com/package/@plumbus/ai-decision)
[![license](https://img.shields.io/npm/l/@plumbus/ai-decision.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai.decide()` (core 0.7.3+) and `ctx.ai.classify()` (core 0.7.4+) against decision adapters registered under `decisions.providers`, separately from text-generation providers.

`@plumbus/ai-decision` is the **shared decision contract package**. It defines the request and answer types (answer types are inferred from the questions), named contracts (`defineDecision`, `DecisionRegistry`), runtime validation of requests and results, `DecisionProviderError`, and the bounded HTTP transport the provider adapters use. Core depends on it and runs `ctx.ai.decide()` through its shared runtime.

Provider packages: `@plumbus/ai-decision-typesafe` (TypeSafe/Jev),
`@plumbus/ai-decision-laya` (self-hosted Laya), and `@plumbus/ai-decision-openai`
(OpenAI Decisions API, needs this package at 0.2.3+). Install only the one the app uses.

## Why?

Typed decision models answer bounded questions (one option from a list, a level on an ordered scale, a probability) instead of generating text, so Plumbus registers them apart from text-generation providers. Each vendor ships as its own optional package, and this package holds what they share:

- One request shape for every provider: `DecisionProviderAdapter.decide()` accepts the same request for TypeSafe, Laya, and OpenAI.
- One validator: core checks the results of built-in and custom adapters with the same rules, and an adapter cannot change the allowed answers.
- One transport: bounded responses, deadlines, cancellation, retry hints, and cleanup, with redirects disabled to protect credentials.

## What you get

| Surface | What it does |
|---|---|
| `defineDecision`, `DecisionRegistry` | Named contracts, validated, copied, and deeply frozen; the CLI discovers `app/decisions/`. |
| `DecisionQuestions`, `DecisionRequest`, `DecisionResult`, `DecisionProviderAdapter`, … | Request, answer, and adapter types, with answer types inferred from the questions. |
| `validateDecisionRequest`, `validateDecisionResult`, `parseDecisionResponse` | Runtime checks of requests and normalized results; an adapter's declared `rounding` widens only the numeric checks (0.2.3+). |
| `toSystemOneQuestions` | Maps questions to the System One wire format used by TypeSafe and Laya. |
| `createDecisionHttpTransport` | Bounded HTTP for adapters: 2 MiB responses, deadlines, cancellation, retries with `Retry-After`, redirects disabled, optional endpoint `{ path }` (0.2.3+). |
| `DecisionProviderError` | Structured failures with `kind`, HTTP status and attempts, known model/usage/cost, and `refusedQuestions` (0.2.3+). |
| `DecisionJsonSchema` | Validates configuration JSON: finite numbers, valid Unicode, at most 64 nested containers. |
| `runDecision`, `@plumbus/ai-decision/types` | The runtime core 0.7.3+ uses for `ctx.ai.decide()`, and a dependency-free type entry for core compilation. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Text responses, structured generation, or embeddings | Built-in text providers in `@plumbus/core` |
| Labels from a generative model | `ctx.ai.classify()` with a text provider (the default) |
| Hosted typed decisions from TypeSafe/Jev | [`@plumbus/ai-decision-typesafe`](../ai-decision-typesafe/) |
| Typed decisions on your own servers, no hosted API | [`@plumbus/ai-decision-laya`](../ai-decision-laya/) |
| Hosted typed decisions from OpenAI (public beta) | [`@plumbus/ai-decision-openai`](../ai-decision-openai/) |
| Named contracts, answer types, or your own adapter | **`@plumbus/ai-decision`** (this package) |

## Status

Shared decision contracts, version `0.2.3` (version-locked **`0.2.x`**); required peer `@plumbus/core` exactly **`0.7.x`**; Node.js 20.6+. **Runtime floor:** `ctx.ai.decide()` needs `@plumbus/core` **≥ 0.7.3** and `ctx.ai.classify({ provider })` needs **≥ 0.7.4**; agent wiring **v17** (core 0.7.4+) links these instructions. Core depends on this package: core 0.7.3 on `~0.2.1`, 0.7.4–0.7.8 on `~0.2.2`, and 0.7.9 on `~0.2.3`.

Not included: vendor model catalogs, automatic environment provider discovery, and dedicated decision CLI commands.

Release notes: [changelog](./CHANGELOG.md) and [version/upgrade guide](../../docs/upgrading-classification.md).

## Install

```bash
pnpm add @plumbus/ai-decision
```

Install explicitly with `pnpm add @plumbus/ai-decision`. Provider packages install
`@plumbus/ai-decision` transitively. It does not depend on any provider package.

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
// app/decisions/refund.ts
import { defineDecision } from '@plumbus/ai-decision';
import { z } from '@plumbus/core/zod';

export const refundDecision = defineDecision({
  name: 'billing.refund',
  state: z.object({ message: z.string() }),
  questions: {
    refund: { type: 'probability', instructions: 'Does the customer request a refund?' },
  },
});
```

Then, inside a capability handler, with a provider registered under `decisions.providers`:

```ts
const result = await ctx.ai.decide({
  decision: refundDecision,
  state: { message: input.message },
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
import type { DecisionProviderAdapter, DecisionQuestions } from '@plumbus/ai-decision';

const questions = {
  refund: { type: 'probability', instructions: 'Is a refund requested?' },
} as const satisfies DecisionQuestions;

export async function inspect(adapter: DecisionProviderAdapter, text: string) {
  return adapter.decide({ state: text, questions });
}
```

Business logic belongs in Plumbus capabilities/flows and `ctx.*`. These examples
exercise the provider protocol only; they do not provide the core execution lifecycle.

## Key gotchas

- **Register under `decisions`, not as a text provider.** Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Provider names must be distinct across the text and decision registries.
- **Direct adapter calls skip core.** They do not enforce core's PII checks, budgets, identity attribution, action confirmation, or ledger hooks. Use `ctx.ai.decide()` / `ctx.ai.classify()` in capabilities and flows.
- **Unknown cost is `null`, not free.** Explicit zero stays free; a provider without a price returns `null`, and when a dollar budget is configured, unpriced prior calls block further calls.
- **Failed calls are recorded.** Core records one row per dispatched call, including failed and cancelled calls; answer-validation failures keep the known model, usage, and cost because the call may already have been billed.
- **Probabilities are not permissions.** A probability is P(true), not a boolean, and a high confidence value is not authorization or proof of correctness. Validate thresholds on the actual task, model, and language.
- **Retries can repeat cost.** The transport retries HTTP 429, 500, 502, 503, 504, and 529 (two retries by default, honoring `Retry-After`); repeated requests can still incur cost, with no exactly-once guarantee.
- **Core validates with its own copy.** Core checks every `ctx.ai` result again with the `@plumbus/ai-decision` it loads; OpenAI's rounding needs that copy at 0.2.3+ (core 0.7.9, or one deduped copy).
- **Request limits.** Requests contain 1–256 questions and must fit 2 MiB; choices have 2–255 options and scores 2–10 ordered levels. Each selected model imposes further token limits.
- **Strict JSON.** Objects must be plain or null-prototype records; class instances and `__proto__` fields are rejected, and response JSON with duplicate keys fails.

## Documentation / Agent recipes

- **Concept docs:** read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
  for the complete contract, failure behavior, pricing, deployment, and live test environment.
  Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).
- **Classification recipe** (after install): `node_modules/@plumbus/core/instructions/ai-classification.md`
- **Live smoke (monorepo):** [`examples/ai-decision-smoke`](../../examples/ai-decision-smoke) runs the TypeSafe and Laya adapters against a local Laya server through a Plumbus capability.
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/ai-decision/instructions/`):
  - [Instructions index](instructions/README.md)
  - [Framework boundary and usage](instructions/framework.md)
  - [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Provider packages** — [`@plumbus/ai-decision-typesafe`](../ai-decision-typesafe/) · [`@plumbus/ai-decision-laya`](../ai-decision-laya/) · [`@plumbus/ai-decision-openai`](../ai-decision-openai/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
