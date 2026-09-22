# @plumbus/ai-typesafe — framework boundary

**Exact path in a consumer app:** `node_modules/@plumbus/ai-typesafe/instructions/framework.md`

Index: `node_modules/@plumbus/ai-typesafe/instructions/README.md`
Writing questions: `node_modules/@plumbus/ai-typesafe/instructions/decisions.md`
Testing: `node_modules/@plumbus/ai-typesafe/instructions/testing.md`

`@plumbus/ai-typesafe` is the **TypeSafe (Jev) decision provider** for Plumbus. It implements `DecisionProviderAdapter` (typed questions → calibrated probabilities) and an `AIProviderAdapter` whose only working operation is a native `classify`. It is an **optional peer** of `@plumbus/core` (version-locked **`0.7.x`**).

**`package.json` peer:** `"@plumbus/core": "0.7.x"` — copy literally; see `packages/plumbus-core/instructions/peer-dependencies.md`.

## When to use / when not

| Use this package | Do not use |
|------------------|------------|
| Output space is closed: yes/no, one of a set, a level on a rubric | Drafting, summarizing, rewriting, or any open-ended text |
| You need the model's own certainty to route on | Extraction of free-form values (use `ctx.ai.extract` on a text provider) |
| You are currently prompting a chat model for JSON and validating it | Embeddings / RAG ingestion (Jev has no embedding API) |
| Multi-label tagging with a probability per label | Tool calling (Jev has no tool protocol) |
| Ranking, re-ranking, or scoring candidates against a rubric | Image, audio, or video input (text only) |

## Package boundary

| Concern | Owned by |
|---------|----------|
| `DecisionProviderAdapter`, `defineDecision`, `ctx.ai.decide`, `DecisionRegistry` | `@plumbus/core` |
| `noul` / `choice` / `score` builders, shared structural limits | `@plumbus/core` |
| Optional `AIProviderAdapter.classify` hook + `nativeClassify` capability | `@plumbus/core` |
| Cost ledger, budgets, prompt security, explainability | `@plumbus/core` |
| Env discovery `AI_TYPESAFE_*` / `AI_DECISION_*`, `createDecisionAdapter('typesafe')` | `@plumbus/core` (dynamic `createRequire`) |
| `@typesafe-ai/sdk` client, `POST /v1/systemone`, `GET /v1/models` | `@plumbus/ai-typesafe` |
| Jev limits (`JEV_CAPABILITIES`), Jev rates, SDK error mapping | `@plumbus/ai-typesafe` |
| App decisions / capabilities / thresholds | Consumer app (`defineDecision`, `defineCapability`) |

## Install

```bash
pnpm add @plumbus/ai-typesafe
```

Requires `@plumbus/core` **0.7.x** and Node **≥ 20.6.0**. After install on an existing app, refresh agent wiring so coding agents discover these files:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

Missing package + `AI_DECISION_PROVIDER=typesafe` → clear error: run `pnpm add @plumbus/ai-typesafe`.

## Two slots, one credential

The single most common misconfiguration is registering this package as the **chat** default. Read this table before wiring.

| Slot | Env var | `createAIService` field | Serves | This package |
|---|---|---|---|---|
| Chat provider | `AI_DEFAULT_PROVIDER` | `providers` / `defaultProvider` | `generate`, `streamGenerate`, `extract`, `classify`, `retrieve` | `createTypeSafeAdapter` — **classify only**, everything else throws |
| Decision provider | `AI_DECISION_PROVIDER` | `decisionProviders` / `defaultDecisionProvider` | `decide` | `createTypeSafeDecisionAdapter` — the main surface |

**Correct for almost every app:**

```bash
AI_DEFAULT_PROVIDER=openai     # or anthropic / bedrock
AI_OPENAI_API_KEY=sk-...
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
AI_DECISION_MODEL=jev-latest
```

**Correct only for an app with no text surface at all:**

```bash
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
# no AI_DEFAULT_PROVIDER — the decision provider becomes the default so the
# service boots; anything reaching for generate() throws a named error.
```

**Wrong unless you mean it:** `AI_DEFAULT_PROVIDER=typesafe` in an app that also generates text. `ctx.ai.generate()` will throw.

## Programmatic wiring

```typescript
import { createAIService, createOpenAIAdapter } from '@plumbus/core';
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';

const ai = createAIService({
  providers: { openai: createOpenAIAdapter({ apiKey: process.env.AI_OPENAI_API_KEY! }) },
  defaultProvider: 'openai',
  decisionProviders: {
    typesafe: createTypeSafeDecisionAdapter({ apiKey: process.env.AI_TYPESAFE_API_KEY! }),
  },
  defaultDecisionProvider: 'typesafe',
  defaultDecisionModel: 'jev-1.13.0',
});
```

## Environment variables

| Variable | Purpose |
|---|---|
| `AI_TYPESAFE_API_KEY` | Credentials. `TYPESAFE_API_KEY` is also accepted (the SDK reads it natively); the `AI_`-prefixed name wins when both are set. |
| `AI_TYPESAFE_MODEL` | Default model for the slot. |
| `AI_TYPESAFE_BASE_URL` | API root override. |
| `AI_TYPESAFE_REQUEST_TIMEOUT` | Timeout **per attempt** in ms (SDK default 10 000). Not a total retry budget. |
| `AI_TYPESAFE_DAILY_COST_LIMIT` | Daily USD cap fed into the cost tracker. |
| `AI_DECISION_PROVIDER` | Enables `ctx.ai.decide()`. Only `typesafe` today. |
| `AI_DECISION_MODEL` | Default decision model; falls back to `AI_TYPESAFE_MODEL`. |
| `DECISION_{NAME}_PROVIDER` | Per-decision provider override. Dots → underscores, uppercased. |
| `DECISION_{NAME}_MODEL` | Per-decision model override. |

So a decision named `support.triageTicket` is overridden by `DECISION_SUPPORT_TRIAGETICKET_MODEL`.

A present-but-empty key is treated as unset. If TypeSafe is the decision provider, that logs a warning naming `AI_TYPESAFE_API_KEY` and leaves `ctx.ai.decide()` unavailable — check startup logs when `decide()` reports "not configured".

## Public exports

| Export | Role |
|--------|------|
| `createTypeSafeDecisionAdapter(config)` | Sync factory → `DecisionProviderAdapter` (`name: 'typesafe'`) |
| `createTypeSafeAdapter(config)` | Sync factory → `AIProviderAdapter` with native `classify`; generation throws |
| `JEV_CAPABILITIES` | Declared limits: 255 choice options, 2–10 score levels, 64k/32k token budgets |
| `calculateJevCost` / `findJevInputRate` | Package-owned rates (input tokens only) |
| `mapTypeSafeError` / `PROVIDER_NAME` | SDK → `ProviderAPIError` mapping; advanced use |
| `TypeSafeAdapterConfig` / `TypeSafeClassifyAdapterConfig` | Config types |
| `noul` / `choice` / `score` | Re-exported SDK builders, so you need no second direct dependency. Core's identically-shaped helpers also work. |

## Config reference

| Field | Default | Notes |
|---|---|---|
| `apiKey` | `TYPESAFE_API_KEY` | |
| `defaultModel` | `jev-latest` (SDK) | |
| `baseUrl` | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` | Maps to the SDK's `baseURL` |
| `requestTimeout` | 10 000 ms (SDK) | Per attempt |
| `retry` | SDK defaults | Partial `RetryPolicy`; SDK already retries 408/429/5xx with `retry-after` |
| `client` | — | Pre-built `TypeSafeClient`; ignores every other connection field. Use for tests and custom transport |
| `labelThreshold` | `0.5` | `createTypeSafeAdapter` only — minimum probability for `classify()` to keep a label |

## Limits (enforced before network I/O)

| Limit | Value |
|---|---|
| Options per Choice | 255 |
| Levels per Score | 2 to 10 |
| Tokens: `state` + all questions | 64 000 |
| Tokens: `state` + longest question | 32 000 |
| Rate limit | 250k tokens/s, 1200 req/min → `429` |

Core validates question structure against these at `defineDecision()` time **and** again before the call, so a malformed rubric fails locally with the offending question id rather than as a provider `422`. The framework does not split an over-budget question map across requests — that is a caller error.

## Pricing

| | |
|---|---|
| Rate | $42/Btok input = **$0.042/MTok** |
| Output tokens | **Free** |

The adapter sets `cost` on every response and `createAIService` prefers it over core's `MODEL_PRICING` catalog. Core still carries `jev-*` rows so budget estimation works without the add-on. A non-Jev model name returns no `cost`, so the catalog applies rather than recording a wrong zero.

Ledger rows land under operation `decide` (or `classify`), carrying the **versioned** model id that answered and the decision name in `promptName`.

## Errors

| SDK error | HTTP | `retryable` |
|---|---|---|
| `AuthenticationError` | 401 | `false` |
| `PermissionDeniedError` | 403 | `false` |
| `UnprocessableEntityError` | 422 | `false` |
| `RateLimitError` | 429 | `true` |
| `InternalServerError` | 5xx (incl. 529) | `true` |
| `APIConnectionError` / `APITimeoutError` | — | `true` |
| `APIUserAbortError` | — | passed through untouched |

The SDK retries before an error reaches core, so `retryable: true` means "still failing after the SDK gave up". A caller abort stays an abort so a deliberate `ctx.signal` cancellation is not recorded as an outage.

## Native classify

`createTypeSafeAdapter` declares `capabilities.nativeClassify` and implements the optional `classify` hook, so `ctx.ai.classify()` skips prompt synthesis. It asks **one Noul per label in a single request** and keeps labels at or above `labelThreshold`.

The catch: `ctx.ai.classify()` always uses the **default** provider and takes no per-call override, so this only applies when TypeSafe *is* `AI_DEFAULT_PROVIDER` — which also makes `generate()` throw. In an app that generates text, use `decide()` with one Noul per label instead; you get the probabilities and keep your text provider as the default. See [decisions.md](./decisions.md).

## Framework-first rule

Decision contracts, thresholds, and routing belong in Plumbus primitives:

- `defineDecision()` in `app/decisions/` for reusable question sets, with a `state` Zod schema.
- `defineCapability()` with `ai: true` in `effects` and `explanation: { enabled: true }`.
- `ctx.ai.decide()` for the call; plain TypeScript for the branching.

Do **not** import `@typesafe-ai/sdk`, hand-roll an HTTP client, or reimplement retries, cost tracking, or budget checks in app code. This package is an adapter, not a parallel AI runtime.

## Monorepo docs

- `docs/ai/decisions.md` — the primitive: question types, contracts, confidence routing, fan-out
- `docs/ai/typesafe.md` — this package in depth: env, limits, pricing, errors, jagged edges, checklist
- `docs/ai/ai-integration.md` — the wider AI stack
