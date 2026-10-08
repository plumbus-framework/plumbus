# @plumbus/ai-decision-openai

Release notes: [changelog](./CHANGELOG.md).

[OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions) provider for
typed choices, scores, and probabilities (`POST /v1/decisions`, default model `gpt-6-luna`).

OpenAI's Decisions API is in public beta. This adapter follows OpenAI's documentation as of
2026-10-08 and may need a patch release if the API changes when it becomes generally available.

Version `0.2.0`; required peer `@plumbus/core` exactly `0.7.x`; Node.js 20.6+.
Install explicitly with `pnpm add @plumbus/ai-decision-openai`. Provider packages install
`@plumbus/ai-decision` (`0.2.3+`) transitively. There is no dependency on the OpenAI SDK
or on the other decision providers.

Through `ctx.ai`, core checks every result again with its own copy of
`@plumbus/ai-decision`, and only 0.2.3+ allows for this adapter's rounding. Core 0.7.9
depends on `~0.2.3`. On core 0.7.3–0.7.8, run `pnpm dedupe` after installing and check
that `pnpm why @plumbus/ai-decision` lists a single 0.2.3+ copy. With an older copy,
core rejects OpenAI's rounded answers as `invalid_response` after the call is billed.

## Scope

Core `0.7.3+` provides `ctx.ai.decide()` with shared validation, security, budgets,
and per-call cost recording; core **0.7.4+** routes `ctx.ai.classify({ text, labels,
provider, model, threshold })` to decision adapters. Register this adapter under
`decisions.providers` in `app/server.ts`. Use a key such as `openai-decisions` so it does
not collide with an `openai` text-generation provider. Cost rows record the adapter's
provider name, `openai-decisions`, whatever key you choose. See the
[decision integration guide](../../docs/ai/decision-providers.md#application-integration-and-cost-recording)
and `node_modules/@plumbus/core/instructions/ai-classification.md`.

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

The bundled `gpt-6-luna` rate is $0.10 per million input tokens, doubled above 272K input
tokens as OpenAI bills long prompts. An `inputRates` entry replaces the bundled rate and is
applied flat, without the long-context doubling. Use one to include regional processing, for
example `{ 'gpt-6-luna': 0.11 }` for OpenAI's 10% uplift.

## Quick start (infrastructure / smoke testing)

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

## Documentation

Read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
for the complete contract, failure behavior, pricing, and live test environment.
Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).

## Agent recipes

- [Instructions index](instructions/README.md)
- [Framework boundary and usage](instructions/framework.md)
- [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision-openai` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
