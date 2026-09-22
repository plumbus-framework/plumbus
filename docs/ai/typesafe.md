# TypeSafe / Jev (`@plumbus/ai-typesafe`)

> Optional add-on for Plumbus AI: **TypeSafe's Jev** decision model behind `ctx.ai.decide()`, plus a Jev-backed `ctx.ai.classify()`. Typed questions in, calibrated probabilities out — no text generation.

This page is the detailed integration guide for the package. For the framework primitive it serves — `defineDecision`, question types, confidence routing — read [Typed Decisions](./decisions.md) first. For the broader AI stack (prompts, RAG, OpenAI/Anthropic, ledger), see [AI Integration](./ai-integration.md). Consumer agent recipes ship inside the package under `node_modules/@plumbus/ai-typesafe/instructions/`.

---

## Table of contents

1. [What this package is (and is not)](#what-this-package-is-and-is-not)
2. [Why a separate package (not in core)](#why-a-separate-package-not-in-core)
3. [Install and peers](#install-and-peers)
4. [Wire the adapters](#wire-the-adapters)
5. [Environment variables](#environment-variables)
6. [Authentication](#authentication)
7. [Models and aliases](#models-and-aliases)
8. [Limits and budgets](#limits-and-budgets)
9. [Pricing and cost ledger](#pricing-and-cost-ledger)
10. [Native classify](#native-classify)
11. [Errors and retries](#errors-and-retries)
12. [Observability](#observability)
13. [Testing](#testing)
14. [Jagged edges](#jagged-edges)
15. [Gaps and non-goals](#gaps-and-non-goals)
16. [Gotchas (read this)](#gotchas-read-this)
17. [Checklist before production](#checklist-before-production)

---

## What this package is (and is not)

| | |
|---|---|
| **Package** | `@plumbus/ai-typesafe` `0.1.x` |
| **Peer** | `@plumbus/core` `0.7.x` (literal range — copy from `packages/plumbus-core/instructions/peer-dependencies.md`) |
| **SDK** | `@typesafe-ai/sdk` (`^0.6.0`, Node ≥ 20) |
| **Endpoint** | `POST https://api.typesafe.ai/v1/systemone` |
| **Plumbus surfaces** | `DecisionProviderAdapter` registered as `decisionProviders.typesafe`; `AIProviderAdapter` with a native `classify` hook registered as `providers.typesafe` |
| **Not included** | Text generation, streaming, embeddings, tool calling, image/audio input |

Jev is a **System One** model: it takes a `state` plus a map of typed questions and returns one typed answer per question with calibrated probabilities. It generates no text. `complete()`, `stream()`, and `embed()` on the provider adapter reject with a message naming the surface you should use instead — they are not silently degraded, and they are not a pretense of support.

Business logic still uses `defineDecision`, `ctx.ai.decide`, and `ctx.ai.classify`. App code does **not** import the TypeSafe SDK directly — only register the adapters.

---

## Why a separate package (not in core)

| Provider | Lives in | HTTP / SDK | Auth | Cost USD source |
|---|---|---|---|---|
| OpenAI | `@plumbus/core` | `fetch` to OpenAI HTTP API | API key | Core `MODEL_PRICING` catalog |
| Anthropic | `@plumbus/core` | `fetch` to Anthropic HTTP API | API key | Core `MODEL_PRICING` catalog |
| Bedrock | `@plumbus/ai-bedrock` | `@aws-sdk/client-bedrock-runtime` | IAM / IRSA | Package-owned rates |
| **TypeSafe** | **`@plumbus/ai-typesafe`** | **`@typesafe-ai/sdk`** | **API key** | **Package-owned rates** |

The split matches the other optional peers (`@plumbus/mcp`, `@plumbus/api`, `@plumbus/ai-bedrock`, the voice providers): apps that never make a typed decision never install the TypeSafe SDK, and core releases stay decoupled from SDK churn.

Core keeps `jev-*` rows in its pricing catalog anyway, so budget estimation and `listModels` still work without the add-on — but the package returns an explicit `cost`, which the AI service prefers.

```
@plumbus/core                             @plumbus/ai-typesafe
─────────────                             ────────────────────
createAIService                           createTypeSafeDecisionAdapter
  decisionProviders.typesafe        ──►     POST /v1/systemone
  providers.typesafe                ──►   createTypeSafeAdapter (classify only)
createDecisionAdapter('typesafe')   ──►   (dynamic createRequire)
DecisionResponse.cost               ◄──   usage.input_tokens × Jev rate
MODEL_PRICING jev-* rows                  package-owned rates (authoritative)
```

---

## Install and peers

```bash
pnpm add @plumbus/ai-typesafe
```

| Dependency | Range | Notes |
|---|---|---|
| `@plumbus/core` (peer) | `0.7.x` | Copy literal; never `^0.7.0` |
| Core optional peer on this package | `0.1.x` | Declared in `@plumbus/core` `peerDependencies` / `peerDependenciesMeta` |
| `@typesafe-ai/sdk` (dependency) | `^0.6.0` | Bundled with the package; Node ≥ 20 |
| Publish order | ai-typesafe **before** core | See `.github/workflows/publish.yml` |

Refresh agent wiring so consumer agents discover the package instructions:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

Missing package plus `AI_DECISION_PROVIDER=typesafe` gives a clear error at boot: run `pnpm add @plumbus/ai-typesafe`.

---

## Wire the adapters

### Environment-driven (recommended)

```bash
AI_DEFAULT_PROVIDER=openai
AI_OPENAI_API_KEY=sk-...

AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
AI_DECISION_MODEL=jev-latest
```

`loadConfig()` builds the `typesafe` slot from `AI_TYPESAFE_*`, and `AI_DECISION_PROVIDER` promotes it into the decision slot. The server and worker bootstraps construct the adapter through `createDecisionAdapter('typesafe')`, which resolves this package with a dynamic `createRequire` — the same mechanism as the Bedrock peer.

This is the configuration most apps want: OpenAI (or Anthropic, or Bedrock) for text, TypeSafe for decisions.

### Programmatic

```typescript
import { createAIService, createProviderAdapter } from '@plumbus/core';
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';

const ai = createAIService({
  providers: {
    openai: createProviderAdapter('openai', { apiKey: process.env.AI_OPENAI_API_KEY! }),
  },
  defaultProvider: 'openai',

  decisionProviders: {
    typesafe: createTypeSafeDecisionAdapter({
      apiKey: process.env.AI_TYPESAFE_API_KEY!,
      defaultModel: 'jev-1.13.0',
      requestTimeout: 15_000,
    }),
  },
  defaultDecisionProvider: 'typesafe',
});
```

### Decisions only

An app whose only AI use is typed decisions can omit `AI_DEFAULT_PROVIDER` entirely:

```bash
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
```

The decision provider becomes the default so the AI service still boots. Anything that reaches for `generate()` then gets the "does not support" error from the adapter rather than a confusing boot failure.

### Config reference

| Field | Default | Purpose |
|---|---|---|
| `apiKey` | `TYPESAFE_API_KEY` | Credentials |
| `defaultModel` | `jev-latest` (SDK) | Model when a request omits one |
| `baseUrl` | `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai` | API root |
| `requestTimeout` | `10_000` (SDK) | Timeout **per attempt**, not a total retry budget |
| `retry` | SDK defaults | Partial `RetryPolicy` override |
| `client` | — | Pre-built `TypeSafeClient`; ignores every other connection field. For tests and custom transport |
| `labelThreshold` | `0.5` | Classify only: minimum probability for a label to be returned |

---

## Authentication

A single API key, passed as `Authorization: Bearer <key>` by the SDK.

The framework slot accepts either name:

| Variable | Read by |
|---|---|
| `AI_TYPESAFE_API_KEY` | Plumbus config loader (the framework-prefixed convention) |
| `TYPESAFE_API_KEY` | The TypeSafe SDK natively, and accepted as a fallback by the slot |

Set one. If both are set, `AI_TYPESAFE_API_KEY` wins, so the framework convention stays authoritative in a deployment that also has the SDK variable lying around.

A present-but-empty key is treated as unset: the slot is skipped so a leftover blank dotenv line does not crash worker boot. If TypeSafe is your decision provider, that produces a warning naming `AI_TYPESAFE_API_KEY` and leaves `ctx.ai.decide()` unavailable.

---

## Models and aliases

Every model is served by the same endpoint; the request's `model` field selects which one.

| Name | Kind | Resolves to |
|---|---|---|
| `jev-1.13.0` | Versioned id | Itself |
| `jev-latest` | Alias | The most recent stable release |
| `jev-preview` | Alias | The most recent release, stable or not |

`GET /v1/models` is exposed through `listModels()` on both adapters:

```typescript
const models = await decisionAdapter.listModels?.();
// [{ name: 'jev-latest', description: '…', releaseDate: '…' }]
```

The endpoint currently lists the aliases. Versioned ids are accepted by the `model` field whether or not they appear in the list, so do not treat the list as an allowlist.

**Pin a version wherever a confidence threshold is tuned.** An alias moves when a new release ships, and calibration can move with it. `DecisionResponse.model` always reports the version that actually answered, and the AI service records that version in the cost ledger and the explainability entry — so even on an alias you can tell after the fact which version produced a result.

In `listModels()` on the provider adapter, Jev reports `kind: 'decision'`. A `listModels({ kind: 'text' })` call returns `[]` rather than leaking a decision model into a text-model picker.

---

## Limits and budgets

Declared on the adapter as `capabilities`, so the AI service enforces them **before** any network I/O and you get a named local error instead of a provider `422`.

| Limit | Value | Enforced by |
|---|---|---|
| Options per Choice | 255 | `defineDecision()` and `decide()` |
| Levels per Score | 2 to 10 | `defineDecision()` and `decide()` |
| Tokens for `state` + all questions | 64k | `decide()` (coarse estimate, ~4 chars/token) |
| Tokens for `state` + longest question | 32k | Provider-side |
| Rate limit | 250k tokens/second, 1200 requests/minute | Provider-side → `429` |

```typescript
JEV_CAPABILITIES;
// { maxChoiceOptions: 255, scoreLevels: { min: 2, max: 10 },
//   maxRequestTokens: 64_000, maxStateTokens: 32_000 }
```

Jev ingests the state once and evaluates every question against it in parallel, which is why batching questions into one call is both cheaper and faster than asking them one at a time. The framework does **not** split an over-budget question map across requests — an oversized request is a caller error, and the adapter says so with the estimated token count in the message.

Rate limits are adjusting dynamically while TypeSafe scales, so treat the numbers above as current rather than contractual. The SDK backs off and honors `retry-after`, so a brief burst over the limit is absorbed without your code seeing it.

---

## Pricing and cost ledger

| | |
|---|---|
| **Rate** | $42 per Btok (billion) of input, which is **$0.042 per MTok** |
| **Output tokens** | **Free** |
| **Owned by** | This package (`src/pricing.ts`), with `jev-*` rows in core's catalog as a fallback |
| **Source** | <https://docs.typesafe.ai/models> |

The adapter computes `cost` from `usage.input_tokens × rate` and returns it on every response. `createAIService` prefers an adapter-supplied `cost` over its own catalog, so the package's rates are authoritative. When the model name is not a Jev model at all, the adapter returns no `cost` and the service falls back to core's catalog rather than recording a wrong zero.

An unreleased `jev-*` version (say `jev-1.14.0`) falls back to the shared rate rather than reporting no cost, on the grounds that a slightly stale rate beats a silent `$0` in a FinOps dashboard.

Ledger rows land under operation `decide` (or `classify` for the native hook):

```typescript
{
  operation: 'decide',
  provider: 'typesafe',
  model: 'jev-1.13.0',
  promptName: 'support.triageTicket',
  usage: { inputTokens: 296, outputTokens: 20, totalTokens: 316 },
  cost: 0.0000124,
  status: 'success',
}
```

Budgets work as they do elsewhere. `AI_TYPESAFE_DAILY_COST_LIMIT` feeds the cost tracker, and `decide()` pre-checks the budget from the serialized request before spending anything.

Because output tokens are free and the state is billed once no matter how many questions ride along, the cost curve here is unlike a chat model's. Fifteen questions in one call cost roughly what one costs. See [Ask many questions at once](./decisions.md#ask-many-questions-at-once).

---

## Native classify

`createTypeSafeAdapter` implements `AIProviderAdapter` with `capabilities.nativeClassify = true` and a `classify` hook. When it is the default provider, `ctx.ai.classify()` routes there and skips prompt synthesis and JSON parsing entirely.

**How it maps.** `classify()` is multi-label, so a single Choice would be the wrong shape — it returns exactly one option. The adapter instead asks **one Noul per label in a single request**, with explicit yes/no criteria, and keeps the labels whose probability is at or above `labelThreshold` (default `0.5`). One request, an independent probability per label, and the multi-label contract preserved.

```typescript
createTypeSafeAdapter({ apiKey, labelThreshold: 0.7 });
```

Raise the threshold for precision, lower it for recall.

```bash
AI_DEFAULT_PROVIDER=typesafe
AI_TYPESAFE_API_KEY=ts-...
```

```typescript
const labels = await ctx.ai.classify({
  labels: ['billing', 'technical', 'sales', 'spam'],
  text: ticket.body,
});
```

**The constraint to understand before you reach for this.** `ctx.ai.classify()` always uses the *default* provider and takes no per-call override. Making classify Jev-backed therefore means `AI_DEFAULT_PROVIDER=typesafe`, which also routes `generate()`, `streamGenerate()`, `extract()`, and `embed()` here, where they throw. That is the right setup only for an app whose entire AI surface is decisions and labels.

Apps that need generation **and** Jev-backed labels should skip `classify()` and use `decide()` with one Noul per label. Same request shape, same cost, and you keep the raw probabilities plus your text provider as the default. There is a worked example in [Typed Decisions § Native classify](./decisions.md#native-classify).

---

## Errors and retries

The SDK owns retries: by default it retries `408`, `429`, and `500`–`599` up to twice with exponential backoff and jitter, and honors `Retry-After` / `retry-after-ms`. The framework does not add a second retry layer on top of it. Override with `retry` if your deployment needs different behavior.

Errors that survive the SDK's retries are mapped onto core's `ProviderAPIError`:

| TypeSafe SDK error | HTTP | `ProviderAPIError.retryable` | Notes |
|---|---|---|---|
| `AuthenticationError` | 401 | `false` | Check `AI_TYPESAFE_API_KEY` |
| `PermissionDeniedError` | 403 | `false` | |
| `UnprocessableEntityError` | 422 | `false` | The request body failed validation; the message names the field |
| `RateLimitError` | 429 | `true` | Message includes the server's retry delay when it sent one |
| `InternalServerError` | 5xx | `true` | Includes `529 Overloaded` |
| `APIConnectionError` / `APITimeoutError` | — | `true` | DNS, TLS, connection closed, timeout |
| `APIUserAbortError` | — | — | **Passed through untouched** |
| `TypeSafeError` (local) | — | `false` | Rejected before the wire, e.g. empty questions |

`retryable` is what drives capability-level retry in core's executor, so it is set only for failures a later attempt could plausibly survive. Note what it means here: the SDK has *already* backed off by the time an error reaches core, so `retryable: true` means "still failing after the SDK gave up", not "never retried".

A caller abort is deliberately **not** converted into a provider failure. Turning a `ctx.signal` cancellation into a `ProviderAPIError` would make deliberate cancellation look like an outage in the cost ledger.

Most `422`s in practice are a malformed question. The adapter validates question structure against `JEV_CAPABILITIES` before the call, so the common cases — too many Choice options, too few or too many Score levels, empty instructions — fail locally with the question id instead.

---

## Observability

With an explainability tracker configured, each `decide()` records an `ai-invocation` entry:

| Field | Value |
|---|---|
| `operation` | `decide` |
| `promptName` | The decision name, when a `defineDecision()` contract was used |
| `provider` | `typesafe` |
| `model` | The **versioned** id that answered |
| `input` | The redacted state |
| `output` | The full `answers` object — probabilities and confidence included |
| `usage` | Token usage |
| `securityWarnings` | Field-classification warnings from the prompt security scan |

Recording the full distribution rather than just the top answer is the point: it is what lets you answer "why was this routed here" months later, and what lets you re-tune a threshold against real traffic.

Prompt security applies to the `state`, the only caller-supplied content in the request. Questions are developer-authored contracts and are not scanned.

SDK-level logging is available through `logLevel` / `logger` on a client you build yourself and pass as `config.client`. Note the SDK's own warning: at `debug` it logs request and response **bodies**, and while known credential headers are redacted, bodies are not. Do not enable it in production against real customer state.

---

## Testing

Never point unit tests at the live API. Two layers, both offline:

**Adapter tests** — pass a stub client:

```typescript
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';
import type { TypeSafeClient } from '@typesafe-ai/sdk';

const client = {
  systemOne: async () => ({
    model: 'jev-1.13.0',
    answers: { isUrgent: { type: 'noul', noul: 0.95 } },
    usage: { input_tokens: 300, output_tokens: 20 },
  }),
  models: { list: async () => [] },
} as unknown as TypeSafeClient;

const adapter = createTypeSafeDecisionAdapter({ client });
```

**Capability and service tests** — use core's helpers and skip this package entirely: `createTestContext({ ai: { decide: … } })` for handlers, `createStubDecisionAdapter` for the full service path. See [Typed Decisions § Testing](./decisions.md#testing-decisions).

**Live smoke** — [`examples/ai-typesafe-smoke`](../../examples/ai-typesafe-smoke) exercises `decide` and native `classify` against the real endpoint and skips when `TYPESAFE_API_KEY` is absent.

---

## Jagged edges

TypeSafe publishes a [known-limitations page per model version](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Read it before you tune thresholds. The ones that bite integration work:

- **English is where accuracy is best.** Other languages, including CJK scripts, are handled but not equally well. Test on your own content and pay closer attention to confidence when routing non-English traffic.
- **Accuracy shifts as the state grows.** A question that is reliable on a short ticket is not automatically reliable on a 30k-token document. Validate at the sizes you actually send.
- **Text only.** No image, audio, or video input. Pre-process non-text inputs into text or structured fields before putting them in `state`.
- **No fine-tuning.** The same weights serve every account. You shape answers through `state`, `instructions`, and `criteria` — not through per-account training. Decompose broad judgments into atomic questions and combine them in code.

---

## Gaps and non-goals

| Capability | Status |
|---|---|
| `ctx.ai.decide()` — noul / choice / score | Yes |
| `ctx.ai.classify()` natively | Yes — one noul per label, one request |
| `listModels()` | Yes — `GET /v1/models` |
| Cost from package-owned rates | Yes — input tokens only |
| SDK retry / `retry-after` honoring | Yes — delegated to the SDK |
| `ctx.ai.generate` / `streamGenerate` / `extract` | **Unsupported** — throws `AIInvalidRequestError`; use a text provider |
| Embeddings, RAG ingestion | **Unsupported** — throws; use OpenAI / Bedrock Titan |
| Tool calling | **Unsupported** — Jev has no tool protocol |
| Multimodal input | Out of scope — model does not accept it |
| Zero data retention | Enterprise plan feature; see TypeSafe's legal docs, not a framework setting |

---

## Gotchas (read this)

1. **This package does not generate text.** Registering it as `AI_DEFAULT_PROVIDER` makes `generate()` throw. That is intended, and the error names the right surface — but it is the single most likely way to misconfigure this package.
2. **Decision and chat providers are separate slots.** `AI_DECISION_PROVIDER=typesafe` does *not* change `AI_DEFAULT_PROVIDER`, and it does not need to.
3. **`AI_DECISION_PROVIDER` with no `AI_TYPESAFE_API_KEY`** warns and leaves `decide()` unavailable rather than failing the boot. Check startup logs for the warning if `decide()` throws "not configured".
4. **`requestTimeout` is per attempt.** With retries enabled, wall-clock time for a failing call can be several times that value. There is no total retry budget.
5. **`baseUrl` maps to the SDK's `baseURL`.** The framework's config field is lowercase-`url` to match `AI_OPENAI_BASE_URL` and friends; the adapter translates.
6. **Aliases move; thresholds do not follow.** Pin `jev-1.13.0` in a contract's `model` once you have tuned against it.
7. **Output tokens are free, input tokens are not.** Optimizing for shorter answers buys nothing here. Optimizing the `state` does.
8. **Question ids are not sent to the model** and play no part in inference — including the `label_0`, `label_1` ids the classify hook generates internally.
9. **Score probabilities are keyed by index as a string** (`'0'`, `'1'`, …), matching the wire format; `legend` maps those keys back to your descriptions.
10. **Do not enable SDK `debug` logging in production.** It logs request and response bodies, which is your customer state.

---

## Checklist before production

- [ ] `pnpm add @plumbus/ai-typesafe`, and `plumbus init --patch` run to refresh agent wiring
- [ ] `AI_TYPESAFE_API_KEY` set from a secret store, not a committed dotenv
- [ ] `AI_DECISION_PROVIDER=typesafe` set, and `AI_DEFAULT_PROVIDER` left pointing at a **text** provider unless the app is decisions-only
- [ ] A versioned model id (`jev-1.13.0`) pinned wherever a confidence threshold is tuned
- [ ] `AI_TYPESAFE_DAILY_COST_LIMIT` or a tracker budget set
- [ ] `explanation: { enabled: true }` on capabilities that call `decide()`
- [ ] Confidence thresholds chosen from logged traffic, with a human-review branch for what falls below
- [ ] Question maps verified against the 64k combined budget at real state sizes
- [ ] SDK `logLevel` left at `warn` (bodies are not redacted at `debug`)
- [ ] The [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13) for your pinned version read

---

## See also

- [Typed Decisions](./decisions.md) — the framework primitive: `defineDecision`, question types, confidence routing, testing
- [AI Integration](./ai-integration.md) — prompts, generation, RAG, cost ledger, security
- [Amazon Bedrock](./bedrock.md) — the other package-owned-pricing provider add-on
- TypeSafe docs: [API reference](https://docs.typesafe.ai/api) · [Models](https://docs.typesafe.ai/models) · [Confidence](https://docs.typesafe.ai/confidence) · [Patterns](https://docs.typesafe.ai/patterns)
