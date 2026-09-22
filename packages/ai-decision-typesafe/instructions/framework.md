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

## Minimal usage

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
4. Do not monkeypatch `ctx.ai`, register these as completion providers, or advertise `ctx.ai.decide()` as available.
5. Preserve distributions and provider confidence separately. A high confidence value is not authorization or proof of correctness.
6. Validate thresholds on the actual task/model/language. Unknown cost is `null`, not free.
7. Pass cancellation/deadlines explicitly during this package-only stage.
8. Keep Python inference outside Node.js. Use the packaged Laya service or implement its documented HTTP protocol.
9. There are no core CLI commands, environment discovery, or `plumbus init` instruction wiring for these packages yet.

Chat, voice and MCP still consume Plumbus capabilities; this package does not
introduce a parallel runtime or transport for those surfaces.

See `docs/ai/decision-providers.md` in the monorepo for the full API and configuration.
