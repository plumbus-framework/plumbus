# @plumbus/ai-typesafe

> **TypeSafe Jev for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** Optional decision-model adapter: ask typed noul / choice / score questions about a state and get **calibrated probabilities** back through `ctx.ai.decide()`. Also backs `ctx.ai.classify()` natively.

[![npm](https://img.shields.io/npm/v/@plumbus/ai-typesafe.svg)](https://www.npmjs.com/package/@plumbus/ai-typesafe)
[![license](https://img.shields.io/npm/l/@plumbus/ai-typesafe.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai` against provider adapters registered on `createAIService`.

`@plumbus/ai-typesafe` is the **TypeSafe decision provider**. It wraps `@typesafe-ai/sdk` (`POST /v1/systemone`) and implements two surfaces:

- `DecisionProviderAdapter` → `ctx.ai.decide()` — typed questions, typed answers, probabilities and confidence.
- `AIProviderAdapter` with a native `classify` hook → `ctx.ai.classify()` runs on Jev, one yes/no question per label in a single request.

Jev is a **System One** model. It generates no text: `complete()`, `stream()`, and `embed()` reject with a message naming the surface to use instead. Keep OpenAI, Anthropic, or Bedrock registered for generation.

## Why?

Structured output from a chat model is a workaround. You prompt for JSON, validate it, retry when it drifts, and then throw away the model's own uncertainty, because a sampled token stream never told you how close the call was.

A decision model inverts that. You declare the question types; it returns a probability distribution per question. Nothing to parse, nothing to repair, and the distribution *is* the uncertainty — so your code can route on confidence instead of pretending every answer is equally good.

That shape does not fit `AIProviderAdapter` (`complete` / `stream` / `embed`), so it gets its own interface and its own registration slot in core. Keeping the SDK in an opt-in peer means apps that never make a typed decision never install it, and core releases stay decoupled from SDK churn.

## What you get

| Surface | What it does |
|---|---|
| `createTypeSafeDecisionAdapter()` | `DecisionProviderAdapter` for `createAIService({ decisionProviders: { typesafe } })`. |
| `createTypeSafeAdapter()` | `AIProviderAdapter` whose `classify` hook runs on Jev; generation throws. |
| `JEV_CAPABILITIES` | Declared limits (255 choice options, 2–10 score levels, 64k/32k token budgets) enforced **before** network I/O. |
| Package-owned pricing | `$0.042`/MTok input, output free; `cost` set on every response and preferred over core's catalog. |
| `listModels()` | `GET /v1/models`, reported as `kind: 'decision'`. |
| Error mapping | SDK errors → core's `ProviderAPIError` with a truthful `retryable`; caller aborts pass through. |
| Env discovery (via core) | After install: `AI_TYPESAFE_API_KEY`, `AI_DECISION_PROVIDER`, `AI_DECISION_MODEL`, … |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Draft, summarize, or rewrite text | OpenAI / Anthropic / Bedrock adapters |
| Extract free-form fields from a document | `ctx.ai.extract` on a text provider |
| Route to one of a known set of handlers | **`ctx.ai.decide()` with a Choice** (this package) |
| Decide yes/no with a probability you can threshold | **`ctx.ai.decide()` with a Noul** |
| Rate content against a rubric | **`ctx.ai.decide()` with a Score** |
| Know how certain the model was | **This package** — text providers do not report calibrated confidence |
| Multi-label tagging | `ctx.ai.classify()` here, or `decide()` with one Noul per label |

## Status

Optional peer of `@plumbus/core` (version-locked **`0.1.x`**; required peer `@plumbus/core` **`0.7.x`**). Install alone is not enough until an adapter is registered (env discovery or `createTypeSafeDecisionAdapter`).

## Install

```bash
pnpm add @plumbus/ai-typesafe
```

Peer (copy literally): `@plumbus/core` `0.7.x`. See `packages/plumbus-core/instructions/peer-dependencies.md`.

After install on an existing app, refresh agent wiring so coding agents discover these instructions:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

## Quick start

```typescript
import { createAIService, createProviderAdapter } from '@plumbus/core';
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';

const ai = createAIService({
  // Text generation stays on a text provider.
  providers: { openai: createProviderAdapter('openai', { apiKey: process.env.AI_OPENAI_API_KEY! }) },
  defaultProvider: 'openai',

  // Typed decisions go to Jev.
  decisionProviders: {
    typesafe: createTypeSafeDecisionAdapter({ apiKey: process.env.AI_TYPESAFE_API_KEY! }),
  },
  defaultDecisionProvider: 'typesafe',
  defaultDecisionModel: 'jev-latest',
});
```

Or via env (after install):

```bash
AI_DEFAULT_PROVIDER=openai
AI_OPENAI_API_KEY=sk-...

AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
AI_DECISION_MODEL=jev-latest
# optional: AI_TYPESAFE_BASE_URL / AI_TYPESAFE_REQUEST_TIMEOUT / AI_TYPESAFE_DAILY_COST_LIMIT
```

Then use the normal Plumbus AI surface:

```typescript
import { choice, noul, score } from '@plumbus/core';

const { answers } = await ctx.ai.decide({
  state: { subject: ticket.subject, body: ticket.body },
  questions: {
    isUrgent: noul('Does this convey urgency?', {
      true: 'Explicitly time-sensitive',
      false: 'No urgency expressed',
    }),
    department: choice('Which team should handle this?', {
      billing: 'Payments, invoicing, refunds',
      technical: 'Bugs, outages, integrations',
    }),
    frustration: score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry']),
  },
});

// Plain code from here.
if (answers.department.confidence < 0.7) return sendToHumanReview();
await route(answers.department.choice);
```

`answers.department.choice` narrows to `'billing' | 'technical'`, so a typo downstream is a compile error.

Reusable decisions belong in `app/decisions/` as `defineDecision()` contracts — auto-discovered and registered like prompts, with their `state` schema parsed before any network call.

**Auth:** one API key. The slot reads `AI_TYPESAFE_API_KEY` or the SDK-native `TYPESAFE_API_KEY`.

## Pricing (input tokens only)

| | |
|---|---|
| Rate | $42 per Btok input = **$0.042 per MTok** |
| Output tokens | **Free** |
| Owned by | This package; core keeps `jev-*` catalog rows as a fallback |

The adapter computes `cost` from `usage.input_tokens × rate` and returns it on every response; `createAIService` prefers it over core's catalog. A non-Jev model name returns no `cost`, so the service falls back to the catalog rather than recording a wrong zero.

The state is billed once no matter how many questions ride along, so fifteen questions in one call cost roughly what one costs. Batch speculatively.

## Key gotchas

- **This package does not generate text.** `AI_DEFAULT_PROVIDER=typesafe` makes `ctx.ai.generate()` throw. Set `AI_DECISION_PROVIDER=typesafe` and leave the default pointing at a text provider unless the app is decisions-only.
- **Decision and chat providers are separate slots.** `AI_DECISION_PROVIDER` does not change `AI_DEFAULT_PROVIDER`, and does not need to.
- **`ctx.ai.classify()` has no per-call provider override** — it always uses the default provider. To get Jev-backed labels without making Jev the default, use `decide()` with one Noul per label.
- **Aliases move.** `jev-latest` can resolve to a new version without any change on your side, and confidence calibration can move with it. Pin `jev-1.13.0` wherever a threshold is tuned; the response's `model` always reports the version that answered.
- **`requestTimeout` is per attempt,** not a total retry budget. The SDK retries `408`/`429`/`5xx` and honors `retry-after`; Plumbus adds no second retry layer.
- **No temperature or maxTokens.** A decision returns a calibrated distribution, not sampled text. Shape answers through `instructions` and `criteria`.
- **Always give Nouls `criteria`.** Without a yes/no rubric the boundary is the model's guess, which is the usual cause of a probability that does not mean what you assumed. Core's governance rules flag it.
- **Ask atomic questions.** "Is this urgent and about billing?" yields one muddled probability; two questions yield two clean ones at essentially the same cost.
- **Do not enable SDK `debug` logging in production** — it logs request and response bodies, which is your customer state.
- **Wiring** — after install, run `plumbus init --patch` so agents see `instructions/`.

## Documentation / Agent recipes

- **Concept docs:** [`docs/ai/decisions.md`](../../docs/ai/decisions.md) (the primitive) · [`docs/ai/typesafe.md`](../../docs/ai/typesafe.md) (this package) · [`docs/ai/ai-integration.md`](../../docs/ai/ai-integration.md)
- **Live smoke (monorepo):** [`examples/ai-typesafe-smoke`](../../examples/ai-typesafe-smoke)
- **Vendor docs:** [API reference](https://docs.typesafe.ai/api) · [Models](https://docs.typesafe.ai/models) · [Confidence](https://docs.typesafe.ai/confidence)
- **Agent recipes** (after install, open these exact paths):
  - `node_modules/@plumbus/ai-typesafe/instructions/README.md`
  - `node_modules/@plumbus/ai-typesafe/instructions/framework.md`
  - `node_modules/@plumbus/ai-typesafe/instructions/decisions.md`
  - `node_modules/@plumbus/ai-typesafe/instructions/testing.md`

## The Plumbus ecosystem

`@plumbus/ai-typesafe` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
