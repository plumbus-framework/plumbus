# AI classification: provider and model selection

Read this when implementing classification, categorization, label selection, or
TypeSafe/Jev and Laya integration. Requires **@plumbus/core 0.7.4+** (0.8 family: **0.8.0-beta.6+**) for the
`classify()` provider/model options. Use this recipe inside Plumbus capabilities
and flows; preserve their access policies and declare `effects.ai: true`.

## Choose the operation

| Need | Operation |
| --- | --- |
| Matching labels from a known list, using a generative or decision model | `ctx.ai.classify()` → `string[]` |
| Typed choices, ordinal scores, probabilities, or mixed questions | `ctx.ai.decide()` → typed answers |
| Generated text or structured output from a prompt | `ctx.ai.generate()` |

Do not call vendor adapters directly for application business logic. Both native
classification and decisions use core validation, security, budgets, identity,
cancellation, and accounting. Predictions never replace authorization.

## Register the provider

Install only the decision provider needed by the app:

```bash
pnpm add @plumbus/core@~0.7.4 @plumbus/ai-decision-typesafe@~0.2.2
# For self-hosted Laya, use @plumbus/ai-decision-laya@~0.2.2 instead.
# 0.8 beta family: pnpm add @plumbus/core@plumbus-next @plumbus/ai-decision-typesafe@plumbus-next
```

Export registration at the server boundary so API and workers share it:

```ts
// app/server.ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

export const decisions = {
  providers: {
    typesafe: createTypeSafeDecisionAdapter({
      apiKey: process.env.TYPESAFE_API_KEY ?? '',
      model: 'jev-1.13.0',
    }),
  },
  defaultProvider: 'typesafe',
};
```

For Laya, register `laya: createLayaDecisionAdapter({ baseUrl, apiKey })` using the
factory from `@plumbus/ai-decision-laya`. Keep credentials and adapter construction
on the server. Laya requires a separately running service. For programmatic
bootstrap, pass `decisions` to `createServer()` / `buildWorkerAiService()` or
`createAIService()`. Decision adapters belong under `decisions.providers`, not the
text-completion `providers` map. Use distinct names across those two maps.

## Select a provider and model per call

```ts
// Inside a capability handler or flow step:
const labels = await ctx.ai.classify({
  text: input.ticketText,
  labels: ['billing', 'technical', 'refund'],
  provider: 'typesafe',
  model: 'jev-1.13.0',
  threshold: 0.5,
  signal: ctx.signal,
  costContext: { projectId: input.projectId },
});
```

`provider` is the registered map key; `model` is a model ID supported by that
endpoint. For Laya automatic language routing use `provider: 'laya', model: 'auto'`;
an explicit checkpoint must be configured on your Laya service.

| Setting | Resolution |
| --- | --- |
| Omitted `provider` | Existing default text provider, even when `decisions.defaultProvider` is set |
| Decision `model` | Per-call `model` → `decisions.defaultModel` → adapter default |
| Text `model` | Per-call `model` → AI service `defaultModel` → adapter default |
| Decision `threshold` | Inclusive probability cutoff in [0, 1], default 0.5 |

For a generative provider, pass its registered name and model and omit `threshold`:

```ts
const labels = await ctx.ai.classify({
  text: input.ticketText,
  labels: ['billing', 'technical'],
  provider: 'openai',
  model: 'gpt-6-sol',
});
```

Native classification accepts 1–256 nonempty labels, batches one independent
probability question per label, and returns matching labels in input order. Zero
or multiple matches are valid. `threshold` is rejected for text providers. Use
`decide()` with a choice question when exactly one choice and its distribution
are required; generative models are not a `decide()` backend.

## Cost recording and tests

Persist the existing `onAICostRecorded` hook. Native classification records one
`operation: 'classify'` row per dispatched logical call, including failures, with
actual model, usage, cost, tenant/actor, and `costContext`. It does not create an
extra `decide` row. Unknown cost remains `null`; never invent zero to bypass a
budget. TypeSafe uses adapter pricing; Laya uses optional `costPerRequestUsd`.

Use `mockAI({ classify: ['billing'] })` through `createTestContext` and
`runCapability` / `simulateFlow` for application tests. Read the installed provider's
`instructions/README.md` for adapter tests. Live Laya inference is opt-in; keep it
out of routine tests.

After upgrading core, run `plumbus init --patch --agent all` and `plumbus doctor`
to refresh agent wiring to **v17**, preserving app-owned text outside managed blocks.

See [AI operations](ai.md), [instruction index](README.md), and the
[decision provider guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md).
