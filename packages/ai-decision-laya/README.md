# @plumbus/ai-decision-laya

> **Self-hosted Laya decisions for [Plumbus](https://github.com/plumbus-framework/plumbus) AI.** Laya provider for self-hosted typed decision inference, with a persistent Python reference service, called through `ctx.ai.decide()` / `ctx.ai.classify()`.

[![npm](https://img.shields.io/npm/v/@plumbus/ai-decision-laya.svg)](https://www.npmjs.com/package/@plumbus/ai-decision-laya)
[![license](https://img.shields.io/npm/l/@plumbus/ai-decision-laya.svg)](https://github.com/plumbus-framework/plumbus/blob/main/LICENSE)
[![peer: @plumbus/core 0.7.x](https://img.shields.io/badge/peer-%40plumbus%2Fcore%200.7.x-blue)](https://www.npmjs.com/package/@plumbus/core)

## What is this?

[Plumbus](https://github.com/plumbus-framework/plumbus) is an **AI-native, contract-driven TypeScript application framework**. Apps call `ctx.ai.decide()` (core 0.7.3+) and `ctx.ai.classify()` (core 0.7.4+) against decision adapters registered under `decisions.providers`, separately from text-generation providers.

`@plumbus/ai-decision-laya` is the **self-hosted Laya adapter**. It sends the shared [`@plumbus/ai-decision`](../ai-decision/) contract over the System One HTTP protocol to a Laya server you run, and checks the answers with the shared validator. The package ships that server: a persistent Python reference service in `service/` (`server.py`, `requirements.txt`, a CPU `Dockerfile`, offline service contract tests) that loads pinned `laya==0.3.5` and keeps the selected checkpoints resident. Python inference stays outside Node.js; any service that implements the same protocol works too.

## Why?

Typed decision models answer bounded questions (one option from a list, a level on an ordered scale, a probability) instead of generating text, so Plumbus registers them apart from text-generation providers. Each vendor ships as its own optional package:

- Apps install only the provider they use; no provider depends on another.
- The contract, validation, and transport live in `@plumbus/ai-decision`, so every provider takes the same request and core checks every result the same way.

This package gives apps that keep inference on their own infrastructure a registered decision provider with no hosted API.

## What you get

| Surface | What it does |
|---|---|
| `createLayaDecisionAdapter()` | `DecisionProviderAdapter` (provider name `laya`) for `decisions.providers` in `app/server.ts`. |
| System One mapping | Shared questions to the System One wire format (`probability` maps to `noul`); answers validated by `@plumbus/ai-decision`. |
| Checkpoint routing | `model: 'auto'` routes by language; an explicit `model` selects a configured checkpoint. Every response must name the checkpoint that answered. |
| Cost estimate | Optional `costPerRequestUsd`, an operator estimate of infrastructure cost; otherwise cost is `null`. |
| Python reference service | `service/`: `GET /healthz` and bearer-authenticated `POST /v1/systemone`, with bounded requests, connection capacity, and one inference at a time. |
| Re-exports | `DecisionProviderError` and the protocol types `DecisionProviderAdapter`, `DecisionQuestions`, `DecisionRequest`, `DecisionResult`. |

## When to use this vs alternatives

| You want | Reach for |
|---|---|
| Text responses, structured generation, or embeddings | Built-in text providers in `@plumbus/core` |
| Labels from a generative model | `ctx.ai.classify()` with a text provider (the default) |
| Hosted typed decisions from TypeSafe/Jev | [`@plumbus/ai-decision-typesafe`](../ai-decision-typesafe/) |
| Typed decisions on your own servers, no hosted API | **`@plumbus/ai-decision-laya`** (this package) |
| Hosted typed decisions from OpenAI (public beta) | [`@plumbus/ai-decision-openai`](../ai-decision-openai/) |
| Named contracts, answer types, or your own adapter | [`@plumbus/ai-decision`](../ai-decision/) |

## Status

Optional decision provider, version `0.2.3` (version-locked **`0.2.x`**); required peer `@plumbus/core` exactly **`0.7.x`**; Node.js 20.6+. **Runtime floor:** `ctx.ai.decide()` needs `@plumbus/core` **≥ 0.7.3** and `ctx.ai.classify({ provider })` needs **≥ 0.7.4**; agent wiring **v17** (core 0.7.4+) links these instructions. Depends on `@plumbus/ai-decision` `~0.2.3`. Install alone is not enough until the adapter is registered under `decisions.providers` and a Laya server is running. Python/model dependencies are installed separately from pnpm.

Not included: vendor model catalogs, automatic environment provider discovery, and dedicated decision CLI commands.

Release notes: [changelog](./CHANGELOG.md) and [version/upgrade guide](../../docs/upgrading-classification.md).

## Install

```bash
pnpm add @plumbus/ai-decision-laya
```

Install explicitly with `pnpm add @plumbus/ai-decision-laya`. Provider packages install
`@plumbus/ai-decision` transitively. There is no dependency on the other decision providers.

Peer (copy literally): `@plumbus/core` `0.7.x`. See `node_modules/@plumbus/core/instructions/peer-dependencies.md`.

If agent wiring predates the decision provider instructions, refresh:

```bash
plumbus init --patch --agent all
plumbus doctor
```

Then start a Laya server. The [Laya service](../../docs/ai/decision-providers.md#laya-service) and [live test environment](../../docs/ai/decision-providers.md#providing-a-live-test-environment) sections cover the CPU container, a plain Python environment, checkpoints, and GPUs.

## Quick start

Core `0.7.3+` provides `ctx.ai.decide()` with shared validation, security, budgets,
and per-call cost recording. Define named contracts with `defineDecision` from
`@plumbus/ai-decision`, and export explicit provider registration as `decisions`
from `app/server.ts` for API and worker processes. See the
[decision integration guide](../../docs/ai/decision-providers.md#application-integration-and-cost-recording).

```ts
// app/server.ts
import { createLayaDecisionAdapter } from '@plumbus/ai-decision-laya';

export const decisions = {
  providers: {
    laya: createLayaDecisionAdapter({
      baseUrl: process.env.LAYA_BASE_URL ?? 'http://127.0.0.1:8080/v1',
      apiKey: process.env.LAYA_API_KEY,
      // costPerRequestUsd: optional operator estimate in USD; omit to report unknown cost
    }),
  },
  defaultProvider: 'laya',
};
```

Then, inside a capability handler:

```ts
const result = await ctx.ai.decide({
  state: { message: input.message },
  questions: {
    refund: { type: 'probability', instructions: 'Does the customer request a refund?' },
  },
  signal: ctx.signal,
});
result.answers.refund.probability; // P(true), not a boolean
```

Core **0.7.4+** also supports `ctx.ai.classify({ text, labels, provider, model, threshold })`
for generative or decision models. Start with
`node_modules/@plumbus/core/instructions/ai-classification.md` for registration,
model defaults, multi-label semantics, and cost recording. For Laya automatic language
routing, use `provider: 'laya', model: 'auto'`.

### Infrastructure / smoke testing

Direct adapter calls remain useful for infrastructure tests and do not record costs
in core. Keep these adapters separate from the text-generation provider registry.

```ts
import { createLayaDecisionAdapter } from '@plumbus/ai-decision-laya';

const adapter = createLayaDecisionAdapter({ baseUrl: 'http://127.0.0.1:8080/v1', apiKey: process.env.LAYA_API_KEY });
const result = await adapter.decide({
  state: 'Please refund the duplicate charge.',
  questions: { refund: { type: 'probability', instructions: 'Is a refund requested?' } },
});
console.log(result.answers.refund.probability);
```

Business logic belongs in Plumbus capabilities/flows and `ctx.*`. These examples
exercise the provider protocol only; they do not provide the core execution lifecycle.

## Pricing (important)

Laya runs on your infrastructure, so there is no provider price list. The adapter reports `cost: null` unless you set `costPerRequestUsd`, an explicit operator estimate for infrastructure usage; zero is accepted only when deliberately configured.

Unknown cost is not free. Core records such calls as unpriced, and when a dollar budget is configured, unpriced prior calls block further calls.

## Configuration

| Option | Default | Notes |
| --- | --- | --- |
| `baseUrl` | required | Service API prefix such as `http://127.0.0.1:8080/v1`; the adapter appends `/systemone` |
| `apiKey` | none | Bearer key; must match the service's `LAYA_API_KEY` |
| `model` | `auto` | `auto` omits the model override so the service routes by language; otherwise a checkpoint the server preloads |
| `language` | none | Sent as the service's optional `lang` field |
| `costPerRequestUsd` | none (cost `null`) | Operator estimate of infrastructure cost per request |
| `timeoutMs` | `30000` | Whole-call deadline, at most five minutes |
| `maxRetries` | `2` | Retries HTTP 429 and transient 5xx only (0–5) |
| `fetch` | `globalThis.fetch` | Injected HTTP implementation for tests |

The reference service reads `LAYA_API_KEY` (required), `LAYA_MODELS` (`english`, `multilingual`, and/or `typed-decisions`; default `english`), `LAYA_DEVICE` (`cpu` or `cuda`), `LAYA_MAX_CONNECTIONS` (1–128, default 32), `LAYA_HOST`, and `LAYA_PORT` (default `127.0.0.1:8080`; the Dockerfile binds `0.0.0.0`). Use `LAYA_MODELS=english,multilingual` for automatic routing across those languages, or a single checkpoint for dedicated workloads.

## Key gotchas

- **Register under `decisions`, not as a text provider.** Export `decisions = { providers, defaultProvider }` from `app/server.ts`; API and workers share it. Provider names must be distinct across the text and decision registries.
- **Direct adapter calls skip core.** They do not enforce core's PII checks, budgets, identity attribution, action confirmation, or ledger hooks. Use `ctx.ai.decide()` / `ctx.ai.classify()` in capabilities and flows.
- **Unknown cost is `null`, not free.** Set `costPerRequestUsd` if budgets should count Laya calls.
- **Failed calls are recorded.** Core records one row per dispatched call, including failed and cancelled calls; answer-validation failures keep the known model, usage, and configured cost.
- **Probabilities are not permissions.** A probability is P(true), not a boolean, and a high confidence value is not authorization or proof of correctness. Validate thresholds on the actual task, model, and language.
- **Retries can repeat work.** The transport retries HTTP 429, 500, 502, 503, 504, and 529 (two retries by default, honoring `Retry-After`); repeated requests can still incur work, with no exactly-once guarantee.
- **Python is not installed by pnpm.** Model dependencies and weights are substantial; the first run downloads a checkpoint.
- **One inference per service process.** A busy device returns 503 with `Retry-After`; deploy replicas for concurrency. An HTTP cancellation cannot interrupt a GPU kernel already running in the Python process.
- **Routing identity is required.** A response without the answering checkpoint fails as `invalid_response`; custom compatible services must return `routing: { model, repo, reason }`.
- **Checkpoints are fixed per server.** A request cannot load a checkpoint outside `LAYA_MODELS`; explicit model selection takes precedence over language routing.
- **Long input is rejected, not truncated.** The service returns HTTP 422 when the tokenizer budget would truncate a question, option, or state. The check is tied to Laya 0.3.5; treat a Laya upgrade as requiring boundary tests.
- **Weights are not pinned.** Package pinning does not pin Hugging Face weight revisions; keep a tested model cache (`HF_HUB_OFFLINE=1` can reuse it).
- **Keep the service private.** Default binding is loopback; put the service behind your deployment's private networking/TLS proxy if accessed remotely.

## Documentation / Agent recipes

- **Concept docs:** read the [decision providers guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
  for the complete contract, failure behavior, pricing, deployment, and live test environment.
  Local monorepo copy: [docs/ai/decision-providers.md](../../docs/ai/decision-providers.md).
- **Classification recipe** (after install): `node_modules/@plumbus/core/instructions/ai-classification.md`
- **Live smoke (monorepo):** [`examples/ai-decision-smoke`](../../examples/ai-decision-smoke) starts a CPU Laya server and runs this adapter and TypeSafe against it with real inference; `scripts/smoke.mjs` sends one live request to `LAYA_BASE_URL` (default `http://127.0.0.1:8080/v1`) when `PLUMBUS_LIVE_DECISION_TESTS=1` and `LAYA_API_KEY` are set (a repository tool, not in the npm package).
- **Agent recipes** (ship in this package, readable from `node_modules/@plumbus/ai-decision-laya/instructions/`):
  - [Instructions index](instructions/README.md)
  - [Framework boundary and usage](instructions/framework.md)
  - [Testing](instructions/testing.md)

## The Plumbus ecosystem

`@plumbus/ai-decision-laya` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## Links

- **Plumbus framework** — [github.com/plumbus-framework/plumbus](https://github.com/plumbus-framework/plumbus)
- **Parent / peer** — [`@plumbus/core`](../plumbus-core/)
- **Shared contracts** — [`@plumbus/ai-decision`](../ai-decision/)
- **Full documentation** — [docs/](../../docs/) in the monorepo
- **Top-level README** — [`../../README.md`](../../README.md)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)

## License

MIT
