# Framework boundary

TypeSafe/Jev provider for typed choices, scores, and probabilities.

## Install and ownership

Install `@plumbus/ai-decision-typesafe` explicitly. Its core peer is exactly `"0.7.x"`.
Consumers reuse Zod/testing utilities from core; do not install them separately.
Use this package for bounded typed decisions. Use core generation and embeddings
for text responses and vector inference.

Public exports: `createTypeSafeDecisionAdapter` — construct an explicitly configured adapter; `DecisionProviderError` — structured failures; `DecisionProviderAdapter`, `DecisionQuestions`, `DecisionRequest`, `DecisionResult` — protocol types.

File map: `src/index.ts` is the public barrel, `src/__tests__/` exercises the public
API, `instructions/` contains these recipes. Laya alone also ships `service/`.

## Classification and model selection (core 0.7.4+)

Read `node_modules/@plumbus/core/instructions/ai-classification.md` for the complete
registration and usage recipe. Call `ctx.ai.classify({ text, labels, provider, model,
threshold })` inside capabilities/flows. `provider` is your registered decision map
key; `model` is an optional endpoint-supported ID. Native `threshold` defaults to
0.5 and returns all matching labels. Use `decide()` for richer questions.

Core records one `classify` cost row, including dispatched failures, with actual
model/usage and identity. Omitted `provider` still uses the text default. Keep
decision adapters under `decisions.providers`, separate from text providers.

## Minimal usage (infrastructure / smoke testing)

```ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

const adapter = createTypeSafeDecisionAdapter({ apiKey: process.env.TYPESAFE_API_KEY ?? '' });
const result = await adapter.decide({
  state: 'Please refund the duplicate charge.',
  questions: { refund: { type: 'probability', instructions: 'Is a refund requested?' } },
});
console.log(result.answers.refund.probability);
```


## Required rules

1. Keep capabilities, flows, access policy and `ctx.*` as the application implementation path.
2. Construct adapters at a server-owned infrastructure boundary and inject them. Keep keys on the server.
3. Treat direct adapter usage as protocol integration, not a replacement for core's security/budget/audit lifecycle.
4. With core 0.7.3+, use `ctx.ai.decide()` in capabilities/flows. Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Do not register decision adapters as completion providers.
5. Preserve distributions and provider confidence separately. A high confidence value is not authorization or proof of correctness.
6. Validate thresholds on the actual task/model/language. Unknown cost is `null`, not free.
7. Pass `signal: ctx.signal` and `timeoutMs` where needed. Flow steps supply their signal by default.
8. Keep Python inference outside Node.js. Use the packaged Laya service or implement its documented HTTP protocol.
9. Define contracts using `defineDecision` from `@plumbus/ai-decision`; CLI startup discovers `app/decisions/`. No automatic environment provider discovery or dedicated decision CLI commands are provided.
10. Core records one `operation: decide` row per dispatched logical call, including failed/cancelled calls, with tenant/actor and `costContext`. Persist it in the existing `onAICostRecorded` hook. Unknown cost is null; never convert it to free usage.

Chat, voice and MCP still consume Plumbus capabilities; this package does not
introduce a parallel runtime or transport for those surfaces.

See `docs/ai/decision-providers.md` in the monorepo for the full API and configuration.
