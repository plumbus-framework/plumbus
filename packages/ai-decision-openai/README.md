# @plumbus/ai-decision-openai

> **OpenAI Decisions API for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) provider for typed choices, scores, and probabilities (`POST /v1/decisions`, default model `gpt-6-luna`), called through `ctx.ai.decide()` / `ctx.ai.classify()` with **input pricing** of the actual response model.

[![npm](https://img.shields.io/npm/v/@plumbus/ai-decision-openai.svg)](https://www.npmjs.com/package/@plumbus/ai-decision-openai)
[![license](https://img.shields.io/npm/l/@plumbus/ai-decision-openai.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai.decide()` (core 0.7.3+) and `ctx.ai.classify()` (core 0.7.4+) against decision adapters registered under `decisions.providers`, separately from text-generation providers.

`@plumbus/ai-decision-openai` is the **OpenAI Decisions API adapter**. It translates the shared [`@plumbus/ai-decision`](../ai-decision/) contract to `POST /v1/decisions` and back, checks the answers with the shared validator, and prices the actual response model. It calls the documented HTTP endpoint directly through the shared transport; there is no OpenAI SDK to install.

## Why?

Typed decision models answer bounded questions (one option from a list, a level on an ordered scale, a probability) instead of generating text, so Plumbus registers them apart from text-generation providers. Each vendor ships as its own optional package:

- Apps install only the provider they use; no provider depends on another.
- The contract, validation, and transport live in `@plumbus/ai-decision`, so every provider takes the same request and core checks every result the same way.

This package gives apps that already use OpenAI a registered decision provider with per-call cost rows, kept apart from the `openai` text provider.

## What you get

| Surface | What it does |
|---|---|
| `createOpenAIDecisionAdapter()` | `DecisionProviderAdapter` (provider name `openai-decisions`) for `decisions.providers` in `app/server.ts`. |
| Decisions API mapping | Shared questions to `predicate`, `choice`, and `score` questions and back; answers validated by `@plumbus/ai-decision` with two-decimal rounding. |
| Input pricing | Bundled `gpt-6-luna` rate (`OpenAIDecisionInputRates`), `inputRates` overrides, priced by the actual response model. |
| Refusals | A refused question fails the call with `error.refusedQuestions`, keeping the billed model, usage, and known cost. |
| Bounded HTTP | Shared transport: deadlines, cancellation, retries on 429 and transient 5xx with `Retry-After`, redirects disabled. |
| Re-exports | `DecisionProviderError` and the protocol types `DecisionProviderAdapter`, `DecisionQuestions`, `DecisionRequest`, `DecisionResult`. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Text responses, structured generation, or embeddings | Built-in text providers in `@plumbus/core` |
| Labels from a generative model | `ctx.ai.classify()` with a text provider (the default) |
| Hosted typed decisions from TypeSafe/Jev | [`@plumbus/ai-decision-typesafe`](../ai-decision-typesafe/) |
| Typed decisions on your own servers, no hosted API | [`@plumbus/ai-decision-laya`](../ai-decision-laya/) |
| Hosted typed decisions from OpenAI (public beta) | **`@plumbus/ai-decision-openai`** (this package) |
| Named contracts, answer types, or your own adapter | [`@plumbus/ai-decision`](../ai-decision/) |

## Status

Optional decision provider, version `0.2.0` (version-locked **`0.2.x`**); required peer `@plumbus/core` exactly **`0.7.x`**; Node.js 20.6+. **Runtime floor:** `ctx.ai.decide()` needs `@plumbus/core` **≥ 0.7.3** and `ctx.ai.classify({ provider })` needs **≥ 0.7.4**; use core **0.7.9** (see [Install](#install)); agent wiring **v19** (core 0.7.9) links these instructions. Depends on `@plumbus/ai-decision` `~0.2.3`. Install alone is not enough until the adapter is registered under `decisions.providers`.

OpenAI's Decisions API is in public beta. This adapter follows OpenAI's documentation as of
2026-10-08 and may need a patch release if the API changes when it becomes generally available.

Not included: vendor model catalogs, automatic environment provider discovery, and dedicated decision CLI commands.

Release notes: [changelog](./CHANGELOG.md) and [version/upgrade guide](../../docs/upgrading-classification.md).

## Install

```bash
pnpm add @plumbus/ai-decision-openai
```

Install explicitly with `pnpm add @plumbus/ai-decision-openai`. Provider packages install
`@plumbus/ai-decision` (`0.2.3+`) transitively. There is no dependency on the OpenAI SDK
or on the other decision providers.

Through `ctx.ai`, core checks every result again with its own copy of
`@plumbus/ai-decision`, and only 0.2.3+ allows for this adapter's rounding. Core 0.7.9
depends on `~0.2.3`. On core 0.7.3–0.7.8, run `pnpm dedupe` after installing and check
that `pnpm why @plumbus/ai-decision` lists a single 0.2.3+ copy. With an older copy,
core rejects OpenAI's rounded answers as `invalid_response` after the call is billed.

Peer (copy literally): `@plumbus/core` `0.7.x`. See `node_modules/@plumbus/core/instructions/peer-dependencies.md`.

If agent wiring predates the decision provider instructions, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

## Quick start

Core `0.7.3+` provides `ctx.ai.decide()` with shared validation, security, budgets,
and per-call cost recording; core **0.7.4+** routes `ctx.ai.classify({ text, labels,
provider, model, threshold })` to decision adapters. Register this adapter under
`decisions.providers` in `app/server.ts`. Use a key such as `openai-decisions` so it does
not collide with an `openai` text-generation provider. Cost rows record the adapter's
provider name, `openai-decisions`, whatever key you choose. See the
[decision integration guide](../../docs/ai/decision-providers.md#application-integration-and-cost-recording)
and `node_modules/@plumbus/core/instructions/ai-classification.md`.

```ts
// app/server.ts
import { createOpenAIDecisionAdapter } from '@plumbus/ai-decision-openai';

export const decisions = {
  providers: {
    'openai-decisions': createOpenAIDecisionAdapter({
      apiKey: process.env.OPENAI_API_KEY ?? '',
      model: 'gpt-6-luna',
    }),
  },
  defaultProvider: 'openai-decisions',
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

### Infrastructure / smoke testing

Direct adapter calls remain useful for infrastructure tests and do not record costs
in core. Keep these adapters separate from the text-generation provider registry.

```ts
import { createOpenAIDecisionAdapter } from '@plumbus/ai-decision-openai';

const adapter = createOpenAIDecisionAdapter({ apiKey: process.env.OPENAI_API_KEY ?? '' });
const result = await adapter.decide({
  state: 'Please refund the duplicate charge.',
  questions: { refund: { type: 'probability', instructions: 'Is a refund requested?' } },
});
console.log(result.answers.refund.probability);
```

Business logic belongs in Plumbus capabilities/flows and `ctx.*`. These examples
exercise the provider protocol only; they do not provide the core execution lifecycle.

## How requests flow

| Plumbus question | OpenAI question | Notes |
| --- | --- | --- |
| `probability` | `predicate` | `criteria.true` / `criteria.false` are appended to the instructions |
| `choice` | `choice` | Criteria keys become choice values; descriptions are optional |
| `score` | `score` | Criteria become ordered level labels; returned level indices are validated |

`state` is sent as `input`: strings unchanged, JSON objects/arrays serialized as JSON
text. Image inputs and `safety_identifier` are not supported yet.

OpenAI does not document the precision of its numbers, so answers are accepted when they
are consistent within two-decimal rounding; options or levels that OpenAI omits get
probability 0. A `refusal` for any question fails the whole call with a
`DecisionProviderError` whose `refusedQuestions` lists the refused question keys.

## Pricing (important)

The adapter prices the **actual response model** from input tokens. The bundled `gpt-6-luna`
rate is $0.10 per million input tokens, doubled above 272K input tokens as OpenAI bills long
prompts ([model pricing](https://developers.openai.com/api/docs/models/gpt-6-luna)), verified
against the [Decisions guide](https://developers.openai.com/api/docs/guides/decisions#pricing-and-availability)
on 2026-10-08. A dated snapshot such as `gpt-6-luna-2026-10-01` uses its alias rate. An
`inputRates` entry replaces the bundled rate and is applied flat, without the long-context
doubling. Use one to include regional processing, for example `{ 'gpt-6-luna': 0.11 }` for
OpenAI's 10% uplift.

Unknown response models return `cost: null`; they are not free. Core records such calls as unpriced, and when a dollar budget is configured, unpriced prior calls block further calls.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | OpenAI API key; keep it on the server |
| `model` | `gpt-6-luna` | Overridden by per-call `model`, then a `defineDecision` contract's `model`, then `decisions.defaultModel` |
| `baseUrl` | `https://api.openai.com/v1` | API prefix; the adapter appends `/decisions` |
| `inputRates` | bundled `gpt-6-luna` rate | Input USD per million tokens, keyed by response model ID |
| `timeoutMs` | `30000` | Whole-call deadline, at most five minutes |
| `maxRetries` | `2` | Retries HTTP 429 and transient 5xx only (0–5) |
| `fetch` | `globalThis.fetch` | Injected HTTP implementation for tests |

## Key gotchas

- **Register under `decisions`, not as a text provider.** Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Provider names must be distinct across the text and decision registries, so do not reuse the key `openai` when the app also registers the OpenAI text provider.
- **Direct adapter calls skip core.** They do not enforce core's PII checks, budgets, identity attribution, action confirmation, or ledger hooks. Use `ctx.ai.decide()` / `ctx.ai.classify()` in capabilities and flows.
- **Unknown cost is `null`, not free.** Only `gpt-6-luna` (and its dated snapshots) is bundled; another response model stays unpriced until you add its `inputRates` entry. Regional processing is not modeled, so those calls are priced without OpenAI's 10% uplift unless an `inputRates` entry includes it.
- **Failed calls are recorded.** Core records one row per dispatched call, including failed and cancelled calls; refusals and malformed answers keep the billed model, usage, and known cost.
- **Probabilities are not permissions.** A probability is P(true), not a boolean, and a high confidence value is not authorization or proof of correctness. Validate thresholds on the actual task, model, and language.
- **Retries can repeat cost.** The transport retries HTTP 429, 500, 502, 503, 504, and 529 (two retries by default, honoring `Retry-After`); repeated requests can still incur cost, with no exactly-once guarantee.
- **Refusals fail the whole call.** `decide()` and `classify()` throw `invalid_response` with `error.refusedQuestions` (for `classify()`, `label_<index>` by position in `labels`); `refusedQuestions` is set only for refusals. Handle it as a business outcome, such as routing to review, not by retrying in a loop.
- **Core needs its own `@plumbus/ai-decision` 0.2.3+.** Use core 0.7.9, or dedupe on core 0.7.3–0.7.8 (see [Install](#install)).
- **Public beta.** OpenAI may change the Decisions API at general availability.

## Documentation / Agent recipes

- **Concept docs:** read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
  for the complete contract, failure behavior, pricing, and live test environment.
  Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).
- **Classification recipe** (after install): `node_modules/@plumbus/core/instructions/ai-classification.md`
- **Live smoke (monorepo):** `scripts/smoke.mjs` sends one live request when `PLUMBUS_LIVE_DECISION_TESTS=1` and `OPENAI_API_KEY` are set (a repository tool, not in the npm package).
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/ai-decision-openai/instructions/`):
  - [Instructions index](instructions/README.md)
  - [Framework boundary and usage](instructions/framework.md)
  - [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision-openai` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Shared contracts** — [`@plumbus/ai-decision`](../ai-decision/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
