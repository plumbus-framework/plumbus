# Framework boundary

OpenAI Decisions API provider for typed choices, scores, and probabilities. OpenAI's
Decisions API is in public beta; this adapter follows OpenAI's documentation as of
2026-10-08 and may need a patch release if the API changes at general availability.

## Install and ownership

Install `@plumbus/ai-decision-openai` explicitly. Its core peer is exactly `"0.7.x"`.
Consumers reuse Zod/testing utilities from core; do not install them separately, and
do not install the `openai` SDK for this adapter. Use this package for bounded typed
decisions. Use core generation and embeddings (the `openai` text provider) for text
responses and vector inference.

Core checks every `ctx.ai` result again with its own copy of `@plumbus/ai-decision`,
and only 0.2.3+ allows for OpenAI's rounding. Core 0.7.9 depends on `~0.2.3`. On core
0.7.3–0.7.8, run `pnpm dedupe` after installing and check that
`pnpm why @plumbus/ai-decision` lists a single 0.2.3+ copy; otherwise core rejects
OpenAI's rounded answers as `invalid_response` after the call is billed.

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
the adapter's provider name, `openai-decisions`, whatever key you register it under.

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

OpenAI does not document the precision of its numbers. The adapter accepts answers that
are consistent within two-decimal rounding: a distribution that sums to 1 within rounding
(at most ten options' worth), a chosen option within rounding of the top option, and a
score within rounding of its distribution's weighted mean. Options or levels that OpenAI omits get probability 0. The
returned values are OpenAI's own; the chosen option is never changed.

## Classification and model selection (core 0.7.4+)

Read `node_modules/@plumbus/core/instructions/ai-classification.md` for the complete
registration and usage recipe. Call `ctx.ai.classify({ text, labels, provider:
'openai-decisions', model, threshold })` inside capabilities/flows. Each label becomes
one `predicate` question in a single `/v1/decisions` request, so a refusal on any label
fails the whole `classify()` call. `threshold` defaults to 0.5 and returns all matching
labels. Use `decide()` for richer questions.

## Required rules

1. Keep capabilities, flows, access policy and `ctx.*` as the application implementation path.
2. Construct adapters at a server-owned infrastructure boundary and inject them. Keep `OPENAI_API_KEY` on the server.
3. Treat direct adapter usage as protocol integration, not a replacement for core's security/budget/audit lifecycle.
4. With core 0.7.3+, use `ctx.ai.decide()` in capabilities/flows. Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Do not register decision adapters as completion providers.
5. Preserve distributions and provider confidence separately. A high confidence value is not authorization or proof of correctness.
6. A `refusal` answer for any question fails the whole call (`decide()` or `classify()`) with a `DecisionProviderError` of kind `invalid_response`; the call is still billed and recorded. Detect it with `error.refusedQuestions`, which is set only for refusals and lists the refused question keys (for `classify()`, `label_<index>` by position in `labels`). Handle it as a business outcome (for example route to review), not by retrying in a loop.
7. Validate thresholds on the actual task/model/language. Unknown cost is `null`, not free. The bundled `gpt-6-luna` rate doubles above 272K input tokens, as OpenAI bills long prompts. `inputRates` entries replace the bundled rate and are applied flat; use one for regional processing (for example `{ 'gpt-6-luna': 0.11 }` for OpenAI's 10% uplift) or a different account rate.
8. Pass `signal: ctx.signal` and `timeoutMs` where needed. Flow steps supply their signal by default.
9. Define contracts using `defineDecision` from `@plumbus/ai-decision`; CLI startup discovers `app/decisions/`.
10. Core records one `decide` or `classify` row per dispatched logical call, including failed/cancelled calls. Persist it in the existing `onAICostRecorded` hook.

Chat, voice and MCP still consume Plumbus capabilities; this package does not
introduce a parallel runtime or transport for those surfaces.

See `docs/ai/decision-providers.md` in the monorepo for the full API and configuration.
