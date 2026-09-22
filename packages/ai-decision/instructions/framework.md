# Framework boundary

Shared decision contracts, runtime validation, structured errors, and HTTP transport.

## Install and ownership

Install `@plumbus/ai-decision` explicitly. Its core peer is exactly `"0.7.x"`.
Consumers reuse Zod/testing utilities from core; do not install them separately.
Use this package for bounded typed decisions. Use core generation and embeddings
for text responses and vector inference.

Public exports: `DecisionProviderAdapter`, request/result/question/answer types; `validateDecisionRequest`, `parseDecisionResponse`, `toSystemOneQuestions`, `createDecisionHttpTransport`, `DecisionProviderError`.

File map: `src/index.ts` is the public barrel, `src/__tests__/` exercises the public
API, `instructions/` contains these recipes. Laya alone also ships `service/`.

## Minimal usage

```ts
import type { DecisionProviderAdapter, DecisionQuestions } from '@plumbus/ai-decision';

const questions = {
  refund: { type: 'probability', instructions: 'Is a refund requested?' },
} as const satisfies DecisionQuestions;

export async function inspect(adapter: DecisionProviderAdapter, text: string) {
  return adapter.decide({ state: text, questions });
}
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
