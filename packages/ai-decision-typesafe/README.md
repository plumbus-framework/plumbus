# @plumbus/ai-decision-typesafe

Release notes: [changelog](./CHANGELOG.md) and [0.8 upgrade notes](../../docs/upgrading-core-0.8.md).

TypeSafe/Jev provider for typed choices, scores, and probabilities.

Version `0.3.0-beta.0` (core 0.8 beta family, npm dist-tag `plumbus-next`); required peer
`@plumbus/core` `>=0.8.0-beta.0 <0.9.0`; Node.js 20.6+.
Install explicitly with `pnpm add @plumbus/ai-decision-typesafe`. Provider packages install
`@plumbus/ai-decision` transitively. There is no dependency on the other provider.

## Scope

Core `0.8.0-beta.6+` provides `ctx.ai.decide()` with shared validation, security, budgets,
and per-call cost recording. Define named contracts with `defineDecision` from
`@plumbus/ai-decision`, and export explicit provider registration as `decisions`
from `app/server.ts` for API and worker processes. See the
[decision integration guide](../../docs/ai/decision-providers.md#application-integration-and-cost-recording).
Direct adapter calls remain useful for infrastructure tests and do not record costs
in core. Keep these adapters separate from the text-generation provider registry.

Core **0.8.0-beta.6+** also supports `ctx.ai.classify({ text, labels, provider, model, threshold })`
for generative or decision models. Start with
`node_modules/@plumbus/core/instructions/ai-classification.md` for registration,
model defaults, multi-label semantics, and cost recording.

## Quick start (infrastructure / smoke testing)

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

## Documentation

Read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
for the complete contract, failure behavior, pricing, deployment, and live test environment.
Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).

## Agent recipes

- [Instructions index](instructions/README.md)
- [Framework boundary and usage](instructions/framework.md)
- [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision-typesafe` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
