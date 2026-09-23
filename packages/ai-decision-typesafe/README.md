# @plumbus/ai-decision-typesafe

Release notes: [changelog](./CHANGELOG.md) and [version/upgrade guide](../../docs/upgrading-voice-and-decision-release.md).

TypeSafe/Jev provider for typed choices, scores, and probabilities.

Version `0.2.0`; required peer `@plumbus/core` exactly `0.7.x`; Node.js 20.6+.
Install explicitly with `pnpm add @plumbus/ai-decision-typesafe`. Provider packages install
`@plumbus/ai-decision` transitively. There is no dependency on the other provider.

## Scope

This is the package-only foundation. Core `ctx.ai.decide()`, named definitions,
provider registration, automatic budgets/auditing, and agent discovery are deferred.
Do not put this adapter into core's text-generation `providers` registry.

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
