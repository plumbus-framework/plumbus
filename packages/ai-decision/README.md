# @plumbus/ai-decision

Shared decision contracts, runtime validation, structured errors, and HTTP transport.

Version `0.2.0`; required peer `@plumbus/core` exactly `0.7.x`; Node.js 20.6+.
Install explicitly with `pnpm add @plumbus/ai-decision`. Provider packages install
`@plumbus/ai-decision` transitively. There is no dependency on the other provider.

## Scope

This is the package-only foundation. Core `ctx.ai.decide()`, named definitions,
provider registration, automatic budgets/auditing, and agent discovery are deferred.
Do not put this adapter into core's text-generation `providers` registry.

## Quick start (infrastructure / smoke testing)

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

## Documentation

Read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
for the complete contract, failure behavior, pricing, deployment, and live test environment.
Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).

## Agent recipes

- [Instructions index](instructions/README.md)
- [Framework boundary and usage](instructions/framework.md)
- [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).
