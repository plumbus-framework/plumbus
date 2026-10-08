# Framework boundary

OpenAI Decisions API provider for typed choices, scores, and probabilities.

## Install and ownership

Install `@plumbus/ai-decision-openai` explicitly. Its core peer is exactly `"0.7.x"`.
Consumers reuse Zod/testing utilities from core; do not install them separately, and
do not install the `openai` SDK for this adapter. Use this package for bounded typed
decisions. Use core generation and embeddings (the `openai` text provider) for text
responses and vector inference.

Public exports: `createOpenAIDecisionAdapter` — construct an explicitly configured adapter;
`OpenAIDecisionInputRates` — bundled input USD per million tokens; `DecisionProviderError` —
structured failures; `DecisionProviderAdapter`, `DecisionQuestions`, `DecisionRequest`,
`DecisionResult` — protocol types.

File map: `src/index.ts` is the public barrel, `src/__tests__/` exercises the public
API, `instructions/` contains these recipes.

## Register the provider

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

Use a registry key other than `openai`: decision and text provider names must be
distinct, and apps commonly register the `openai` text provider too. Cost rows record
the adapter name `openai`; distinguish them from text calls by `operation`
(`decide` / `classify`) and `model`.

Config: `apiKey` (required), `model` (default `gpt-6-luna`), `baseUrl` (default
`https://api.openai.com/v1`; the adapter appends `/decisions`), `inputRates`,
`timeoutMs`, `maxRetries`, `fetch`.

## Question mapping

| Plumbus | OpenAI | Notes |
| --- | --- | --- |
| `probability` | `predicate` | `criteria.true` / `criteria.false` are appended as `True when:` / `False when:` lines |
| `choice` | `choice` | Criteria keys are choice values; `null` descriptions are omitted |
| `score` | `score` | Criteria are ordered level labels (lowest first); score is 0-based |

`state` becomes `input`: strings are sent unchanged; JSON objects/arrays are sent as
JSON text. Image inputs and `safety_identifier` are not supported by this adapter yet.
`probability` answers have no `confidence`; choice/score answers keep OpenAI's
`confidence` separately from the probability distribution.

## Classification and model selection (core 0.7.4+)

Read `node_modules/@plumbus/core/instructions/ai-classification.md` for the complete
registration and usage recipe. Call `ctx.ai.classify({ text, labels, provider:
'openai-decisions', model, threshold })` inside capabilities/flows. Each label becomes
one `predicate` question in a single `/v1/decisions` request. `threshold` defaults to
0.5 and returns all matching labels. Use `decide()` for richer questions.

## Required rules

1. Keep capabilities, flows, access policy and `ctx.*` as the application implementation path.
2. Construct adapters at a server-owned infrastructure boundary and inject them. Keep `OPENAI_API_KEY` on the server.
3. Treat direct adapter usage as protocol integration, not a replacement for core's security/budget/audit lifecycle.
4. With core 0.7.3+, use `ctx.ai.decide()` in capabilities/flows. Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Do not register decision adapters as completion providers.
5. Preserve distributions and provider confidence separately. A high confidence value is not authorization or proof of correctness.
6. A `refusal` answer fails the whole call with `invalid_response`; the call is still billed and recorded. Handle it as a business outcome (for example route to review), not by retrying in a loop.
7. Validate thresholds on the actual task/model/language. Unknown cost is `null`, not free. Regional processing and long-context multipliers are not included in the bundled rate; configure `inputRates` if your account pays a different rate.
8. Pass `signal: ctx.signal` and `timeoutMs` where needed. Flow steps supply their signal by default.
9. Define contracts using `defineDecision` from `@plumbus/ai-decision`; CLI startup discovers `app/decisions/`.
10. Core records one `decide` or `classify` row per dispatched logical call, including failed/cancelled calls. Persist it in the existing `onAICostRecorded` hook.

Chat, voice and MCP still consume Plumbus capabilities; this package does not
introduce a parallel runtime or transport for those surfaces.

See `docs/ai/decision-providers.md` in the monorepo for the full API and configuration.
