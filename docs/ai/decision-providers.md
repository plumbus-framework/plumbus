# Typed decision provider packages

Core **0.7.3+** integrates typed decisions through `ctx.ai.decide()`. Use shared
`@plumbus/ai-decision@0.2.1+` and the matching TypeSafe/Laya adapters for named
contracts, validation, security, budgets, cancellation, and per-call cost records.
The decision packages still work independently for infrastructure tests. Register
decision adapters separately from text-generation providers.

| Package | Responsibility |
| --- | --- |
| `@plumbus/ai-decision` | Shared types, runtime validation, structured errors, bounded HTTP transport |
| `@plumbus/ai-decision-typesafe` | TypeSafe/Jev System One adapter and model-specific input pricing |
| `@plumbus/ai-decision-laya` | Laya HTTP adapter and a separately deployed Python reference service |

The decision packages peer on core `0.7.x`. Core 0.7.4 and the 0.2.2 provider packages
depend on shared contracts `~0.2.2`; neither provider depends on the other. Node.js 20.6+ is
required. Only the Laya service needs Python/model dependencies. The TypeSafe
adapter calls the documented HTTP endpoint directly, using the shared transport;
consumer apps do not need a vendor SDK.

For the researched issue matrix, regressions and local HTTP end-to-end coverage,
see the [58-scenario first audit](decision-provider-audit.md).

## Application integration and cost recording

Define reusable contracts with `defineDecision` from the shared package. The CLI
recursively discovers `app/decisions/` when running `plumbus dev`, `start`, or
`worker`; invalid decision modules fail discovery explicitly. Definitions are
validated, copied, and deeply frozen. An optional `state` Zod schema is checked
before any provider invocation.

```ts
// app/decisions/refund.ts
import { defineDecision } from '@plumbus/ai-decision';
import { z } from '@plumbus/core/zod';

export const refundDecision = defineDecision({
  name: 'billing.refund',
  state: z.object({ message: z.string() }),
  questions: {
    refund: { type: 'probability', instructions: 'Does the customer request a refund?' },
  },
});
```

Register adapters explicitly at the server boundary. `app/server.ts` exports the
same `decisions` configuration to the API and workers, including decision-only
applications without a text-generation provider. Credentials stay in the server's
environment; installing a provider alone does not register it.

```ts
// app/server.ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

export const decisions = {
  providers: {
    typesafe: createTypeSafeDecisionAdapter({ apiKey: process.env.TYPESAFE_API_KEY ?? '' }),
  },
  defaultProvider: 'typesafe',
  budget: { maxTokensPerRequest: 32000, dailyCostLimit: 5 },
};
```

For Laya, register `createLayaDecisionAdapter({ baseUrl, apiKey, costPerRequestUsd })`
under `providers.laya`. The infrastructure estimate is optional: without it, Laya
cost is unknown. For programmatic bootstrap, pass `decisions` to `createServer()`
or `buildWorkerAiService()`; pass `decisions.definitions` or a `DecisionRegistry`
through `decisions.registry` when not using CLI discovery. Direct `createAIService`
callers supply their existing `costTracker` and `security` configuration.

Inside a capability handler:

```ts
const result = await ctx.ai.decide({
  decision: refundDecision,
  state: { message: input.message },
  signal: ctx.signal,
  costContext: { projectId: input.projectId, operationName: 'billing.reviewRefund' },
});
```

`decision: 'billing.refund'` also resolves a registered contract; importing the
object preserves answer-key inference. Inline `questions` are supported. Supply
either a definition/name or inline questions. Per-call `provider`/`model` override
the definition, which overrides runtime defaults. `timeoutMs` reaches the adapter;
flow steps automatically supply their cancellation signal when omitted.

Every dispatched decision call records exactly one logical-call ledger row via
core's `recordProviderCost` and the existing `onAICostRecorded(record, costContext,
db)` hook. Rows carry `operation: 'decide'`, optional `decisionName`, actual response
model, provider, input/output/total tokens, USD cost, elapsed time, and the executing
tenant/actor. Add `decide` to any application-owned operation enum or ledger
schema. Continue using your existing hook to persist rows; the built-in cost
tracker is in memory and does not create a durable database ledger by itself.

Failed responses and cancellations also record rows. Known model, token usage, and
billed cost survive answer-validation errors. If a transport failure supplies no
billing metadata, usage is zero **as an unavailable measurement**, cost is `null`,
and status is `failed`. Raw provider error bodies are excluded from ledger error
messages. Local definition/state/security/budget rejection before dispatch produces
no spend row. A persistence-hook failure follows the existing core policy: log it
without retrying inference or changing the result.

The runtime validates custom adapter results as well as built-in adapters. Unknown
cost remains `null`, even if a similarly named text model exists in the pricing
catalog; explicit zero remains available/free. Unpriced prior calls block further
calls when a dollar budget is configured. The byte-based token estimate checks the
per-request cap before dispatch; this is an approximate framework estimate, not a
provider tokenizer. Provider retries retain the adapters' existing semantics; a
logical ledger row is not an exactly-once billing guarantee.

Security scans both state and structured question content. API/worker registration
reuses entity classifications and the configured AI security mode. Decision budgets
override the bootstrap's text-provider budget defaults and share its tracker with
text calls; process-local trackers do not replace a cross-process application ledger.
Successful calls also reach a configured explainability tracker.

Tests can use `mockAI({ decide: result })` through `createTestContext` and
`runCapability`/`simulateFlow`. Keep business logic and authorization in Plumbus
primitives; decision probabilities never authorize an action by themselves.

## Classification with decision models

Requires core **0.7.4+**. Coding agents should start with the packaged
[classification recipe](../../packages/plumbus-core/instructions/ai-classification.md);
see the [upgrade guide](../upgrading-classification.md) for wiring v17.

Use `classify()` when you only need matching labels; keep `decide()` for typed
choices, scores, probabilities, or several different questions in one request.
Inside a capability handler, select an adapter registered above:

```ts
const labels = await ctx.ai.classify({
  text: 'I was charged twice. Please refund the duplicate charge.',
  labels: ['billing', 'technical', 'refund'],
  provider: 'typesafe', // registered map key
  model: 'jev-1.13.0', // optional model supported by the endpoint
  threshold: 0.5,
});
```

Each label becomes an independent probability question in one provider request.
The returned `string[]` contains labels meeting `threshold` (inclusive, default
`0.5`) in input order, including zero or multiple matches. Supply 1–256 nonempty
labels; `threshold` must be between 0 and 1. Optional `model` overrides the decision
model default: per-call `model` → `decisions.defaultModel` → adapter default.
For Laya automatic language routing, use `provider: 'laya', model: 'auto'`; explicit
checkpoints must be configured on that server. Provider names must be distinct across text and decision registries.

Classification reuses the decision execution path, including security, budgets,
cancellation, and success/failure accounting. It records one `operation: 'classify'`
row and preserves unknown native costs as `null`. Omitting `provider` retains the
existing generative default; text providers also accept per-call `provider` and
`model`, but reject `threshold`.

## Decision integration regression coverage

Core validates a private copy of the question contract, so an adapter cannot
change the allowed answers by mutating its request. Provider identity and billing
context are captured per call. Hook records, returned results, and the in-memory
tracker have independent accounting objects; the hook and tracker share the same
record ID and timestamp for correlation. Broken SDK error accessors cannot prevent
failure accounting or discard other valid metadata. Requests over 2 MiB fail local
validation before provider work.

Provider/name selectors are trimmed consistently. When `definitions` and `registry`
are both configured, definitions (including CLI-discovered contracts) resolve first;
the explicit registry resolves other names.

The following scenarios are executable regression tests, not claims of hosted
provider availability. The HTTP cases run both adapters through real loopback HTTP
servers, Plumbus capability routes, authentication, and a file-backed test ledger.

| ID | Failure scenario | Coverage |
| --- | --- | --- |
| D01 | Whitespace changes provider/definition lookup after validation | Unit |
| D02 | An explicit registry hides discovered definitions | Unit |
| D03 | Adapter mutation changes the question contract used to validate answers | Unit |
| D04 | Caller mutation changes the project billed during an in-flight call | Unit |
| D05 | A ledger hook mutates usage seen by the caller or budget tracker | Unit |
| D06 | Caller mutation rewrites a retained ledger-hook record | Unit |
| D07 | The hook and tracker generate different IDs for one call | Unit |
| D08 | A throwing SDK error getter prevents failure accounting | Unit |
| D09 | Oversized input reaches provider work and consumes budget | Unit |
| D10 | One tenant's exhausted budget affects another tenant | Integration |
| D11 | Adapter metadata changes provider attribution during a call | Unit |
| D12 | A state-schema transform introduces classified fields after input validation | Integration |
| D13 | An unauthenticated HTTP request reaches inference or accounting | HTTP end-to-end |
| D14 | A rate-limit retry creates duplicate cost rows | HTTP end-to-end |
| D15 | Exhausted retries lose the failed row or expose upstream bodies | HTTP end-to-end |
| D16 | Invalid choices/scores lose known billed usage/cost or trigger retries | HTTP end-to-end |
| D17 | A redirect forwards the provider credential | HTTP end-to-end |
| D18 | A stalled response body escapes the deadline or cost hook | HTTP end-to-end |
| D19 | In-flight cancellation loses accounting or records success | HTTP end-to-end |
| D20 | Concurrent requests forge or exchange tenant/actor/project attribution | HTTP end-to-end |

Tests: `packages/plumbus-core/src/ai/__tests__/decision-audit.test.ts` and
`decision-http-e2e.test.ts`. These 20 scenarios have 30 test cases, including both
providers and both malformed choice/score variants.

## Direct adapter contract

```ts
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-decision-typesafe';

const adapter = createTypeSafeDecisionAdapter({
  apiKey: serverConfig.typeSafeApiKey,
  model: 'jev-1.13.0',
});

const result = await adapter.decide({
  state: { text: 'I was charged twice. Please refund the duplicate charge.' },
  questions: {
    department: {
      type: 'choice',
      instructions: 'Which team should handle this request?',
      criteria: { billing: 'Payments and refunds', technical: 'Software bugs', other: null },
    },
    urgency: {
      type: 'score', instructions: 'How urgent is the request?',
      criteria: ['Routine', 'Time sensitive', 'Emergency'],
    },
    refund: { type: 'probability', instructions: 'Is a refund explicitly requested?' },
  },
  signal: abortSignal,
});

result.answers.department.choice; // 'billing' | 'technical' | 'other'
result.answers.urgency.score;       // Expected ordinal level, potentially fractional
result.answers.refund.probability;  // P(true), not a boolean
result.usage;                      // inputTokens, outputTokens, totalTokens
result.cost;                       // USD estimate or null
result.costAvailable;
```

This is an infrastructure/smoke-test example. Application business logic stays in
Plumbus capabilities and flows, with data, events, invocation and authentication
through `ctx.*`. Inject configured adapters at the infrastructure boundary; do not
create global clients or implement a competing workflow runtime. Direct adapter calls do not enforce core's PII
checks, budgets, identity attribution, action confirmation, or ledger hooks.

`DecisionProviderAdapter.decide()` accepts the same request for either provider.
The public `probability` question/answer maps to the providers' `noul` wire format.
State and descriptions support text, JSON objects and arrays. Choices have 2–255
options; scores have 2–10 ordered levels. Requests contain 1–256 questions and must
fit 2 MiB. Each selected model imposes further token limits.

The validator rejects missing/extra answer IDs, mismatched types, unknown choice
labels, a choice that is not a maximum-probability option, invalid distribution
keys/sums, non-finite values, negative usage, and out-of-range scores. Distribution
sum tolerance accounts for Laya's four-decimal rounding. Provider action
predictions are discarded. Choice/score confidence is retained separately from
probabilities. Optional Laya probability confidence is preserved; missing
TypeSafe confidence is not invented. Structured score legends are preserved.
Ordinal scores must agree with their distributions within provider rounding
tolerance. JSON objects must be plain or null-prototype records; class instances
and `__proto__` fields are rejected rather than silently transformed.
The public `DecisionJsonSchema` also validates configuration JSON: finite numbers,
valid Unicode in keys and values, and at most 64 nested containers. Response JSON
rejects duplicate keys, including escaped spellings of the same key. Score legends
must reproduce the requested rubric; object key order does not matter.

## Configuration and failures

Both adapters accept `baseUrl`, `apiKey`, `model`, `timeoutMs`, `maxRetries`, and an
injected `fetch`. Base URLs include the API prefix, such as
`https://api.typesafe.ai/v1` or `http://127.0.0.1:8080/v1`; the transport appends
`/systemone`. URLs cannot contain embedded credentials, query strings or fragments.
Redirects are disabled so bearer keys cannot follow an unexpected endpoint.
Keys must be printable ASCII without whitespace; credentials are never trimmed.
An explicitly null endpoint is invalid rather than selecting the default host.

The default 30-second deadline covers dispatch, response reading and retry delays;
per-request `timeoutMs` overrides it (maximum five minutes). Retries default to two
for HTTP 429, 500, 502, 503, 504 and 529, honoring `Retry-After`. Other HTTP errors,
invalid responses and uncertain network delivery are not retried. Cancellation
and timeouts are structured errors. An HTTP cancellation cannot interrupt a GPU
kernel already running in the Python process. Repeated requests can still incur
work/cost; this transport makes no exactly-once guarantee.

`retry-after-ms` takes precedence over `Retry-After`, matching the TypeSafe SDK's
header precedence. Invalid millisecond hints fall back to the standard header;
huge numeric delays saturate to the timer limit and remain bounded by the request
deadline. When deadline and caller cancellation race, the first signal determines
the reported failure kind.

Deadlines also bound an injected fetch/response reader that ignores cancellation;
they cannot stop work inside that custom implementation. HTTP response cleanup is
best-effort and never replaces the main error. Invalid UTF-8 is rejected instead
of silently substituting replacement characters.

`DecisionProviderError` extends core's `PlumbusError`. Its `kind` distinguishes
configuration, invalid request/response, HTTP, network, timeout and cancellation
failures. HTTP failures expose status and attempt count, never raw response bodies
or credentials. Answer-validation failures preserve model and token usage when a
valid response envelope supplied them; the call may already have been billed.

## Pricing

The TypeSafe adapter defaults to `jev-latest` and prices the **actual response
model**, not the alias. The bundled `jev-1.13.0` rate is $0.042/million input tokens,
with free output, verified against [TypeSafe's model documentation](https://docs.typesafe.ai/models)
on 2026-09-22. Configure `inputRates: { 'model-id': rate }` to override input USD per
million tokens. Unknown response models return `cost: null`; they are not free.
Pricing overrides must be plain JSON records. A positive charge that underflows to
numeric zero raises a configuration error with known usage/model instead of
appearing free; explicit zero rates and zero input usage remain valid.

Laya defaults to `cost: null`. `costPerRequestUsd` is an explicit operator estimate
for infrastructure usage; zero is accepted only when deliberately configured.
Direct adapter calls do not write to the core cost tracker. Calls through
`ctx.ai.decide()` record the normalized cost and usage automatically.

## Laya service

The package ships `service/server.py`, `requirements.txt`, a CPU `Dockerfile`, and
offline service contract tests. The service loads pinned `laya==0.3.5` and keeps
the selected checkpoints resident. It serves:

- `GET /healthz`: readiness and preloaded checkpoint names.
- `POST /v1/systemone`: bearer-authenticated `state`, native `questions`, optional
  `model` and `lang`; responds with native answers, usage and routing metadata.

Configure `LAYA_MODELS=english,multilingual` for automatic routing across those
languages, or a single checkpoint for dedicated workloads. Allowed names are
`english`, `multilingual`, and `typed-decisions`. Explicit model selection takes
precedence over language routing. A request cannot load a checkpoint outside the
configured list. The TypeScript adapter's `model: 'auto'` omits the model override;
`language` supplies the service's optional `lang` field.
Routing metadata is required in Laya adapter responses so a generic model name
cannot conceal which checkpoint answered. Custom compatible services must return
`routing: { model, repo, reason }`.

The service preflights the tokenizer's question/option/state budgets and rejects
input that would be truncated with HTTP 422. This check is deliberately tied to
Laya 0.3.5's sequence construction. It rejects long option descriptions rather
than silently clipping them. Treat a Laya upgrade as requiring boundary tests.
Only one inference runs per service process; busy devices return 503 with
`Retry-After`. Deploy replicas for concurrency. Put the reference HTTP service
behind your deployment's private networking/TLS proxy if accessed remotely.

The service also limits active HTTP handlers (including slow request readers) to
32 by default. Set `LAYA_MAX_CONNECTIONS` from 1 through 128, or pass
`max_connections` to `create_server`, to change it. Capacity exhaustion returns
503 before another handler thread starts or the request body is read. A client
still uploading its body can observe a broken pipe as the rejected socket closes;
the offline capacity test reads the 503 response without sending a body. Client
disconnects during headers or body writes are handled without escaping the
request handler.

Requests require one Content-Length and one Authorization header, UTF-8
`application/json`, and identity Content-Encoding. Duplicate JSON keys,
non-finite numbers, unpaired Unicode surrogates and nesting over 64 levels are
rejected. Incomplete framing returns 400, unsupported content metadata 415, and
invalid JSON/questions 422. Inference/serialization failures return 500; responses
are capped at 2 MiB, matching the adapter.
Duplicate Content-Encoding headers are rejected. The bearer authentication scheme
is case-insensitive; the token itself remains case-sensitive.

Package pinning does not pin Hugging Face weight revisions. Retain a tested model
cache/snapshot for reproducible deployment; `HF_HUB_OFFLINE=1` can reuse a prepared
cache. Routing metadata identifies the checkpoint but is not a weight digest.

## Providing a live test environment

### One-command local server and smoke app

From the repository root, run:

```bash
node examples/ai-decision-smoke/run.mjs
```

The [example app](../../examples/ai-decision-smoke/README.md) builds the packages,
generates a password in `examples/ai-decision-smoke/.env`, starts a CPU Laya server
on loopback, and runs both adapters through a Plumbus capability. The same password
file configures server and clients automatically. It does not read the repository
root `.env` or contact the hosted TypeSafe API. Node 22+, installed pnpm dependencies
and Docker are required. The first run downloads a real checkpoint; the cache
volume is pre-created with ownership suitable for the unprivileged container user.

Use `node examples/ai-decision-smoke/run.mjs smoke` to repeat the test, `status` or
`logs` to inspect the server, and `stop` to stop it. To change the password, edit the
example `.env` and run `restart`; the named model cache is retained. The example
stops a server that a one-off run created or started, including on failure.
For repeated checks, use `start` followed by `smoke`, then `stop` when finished.
Already-running servers are preserved; passwords and model caches stay on disk.

### Using an existing endpoint

Keep keys in a local environment file **outside the repository**, readable by the
account running the agent. Tell the agent its absolute path, never paste keys into
chat. For example, create `/absolute/path/decision-test.env` with permissions `0600`:

```dotenv
PLUMBUS_LIVE_DECISION_TESTS=1
TYPESAFE_API_KEY=your-test-account-key
TYPESAFE_MODEL=jev-1.13.0
LAYA_API_KEY=your-private-service-key
LAYA_BASE_URL=http://127.0.0.1:8080/v1
LAYA_MODEL=english
```

Only the provider being tested needs its key. TypeSafe needs an active account with
inference access and outbound HTTPS connectivity to `api.typesafe.ai`. Its smoke
script sends one fixed, non-sensitive ticket containing three questions. State the
allowed request or spending limit if you want a larger evaluation.

For Laya, provide either an already running compatible endpoint or a Python 3.10+
environment (3.11 recommended), enough RAM for your selected checkpoints, network
access for the initial package/weight downloads, and optionally a CUDA GPU with
matching PyTorch. CPU works for functional testing; GPU is preferable for latency
measurements. Model dependencies and weights are substantial and are **not**
installed by `pnpm install`.

Start the included CPU container from the repo root:

```bash
docker build -t plumbus-laya-test packages/ai-decision-laya/service
docker run --rm --name plumbus-laya-test \
  -p 127.0.0.1:8080:8080 \
  --env-file /absolute/path/laya-service.env \
  -v plumbus-laya-models:/home/laya/.cache/huggingface \
  plumbus-laya-test
```

Use a **separate service env file** containing only `LAYA_API_KEY`, `LAYA_MODELS`
(for example `english,multilingual`), and optionally `HF_TOKEN` for weight access.
The client and service Laya keys must match. Wait for the ready message and verify:

```bash
curl --fail http://127.0.0.1:8080/healthz
```

Alternatively, create an isolated Python environment, install
`packages/ai-decision-laya/service/requirements.txt`, set `LAYA_API_KEY`,
`LAYA_DEVICE=cpu` or `cuda`, and `LAYA_MODELS`, then run
`python packages/ai-decision-laya/service/server.py`. Default binding is loopback.

Build and run smoke scripts from the repo root:

```bash
pnpm --filter '@plumbus/ai-decision*' build
node --env-file=/absolute/path/decision-test.env packages/ai-decision-typesafe/scripts/smoke.mjs
node --env-file=/absolute/path/decision-test.env packages/ai-decision-laya/scripts/smoke.mjs
```

The scripts require `PLUMBUS_LIVE_DECISION_TESTS=1`, print only the synthetic request's
validated results/usage/cost, and stay outside the default test suite. If service
routing is being tested, unset `LAYA_MODEL`; otherwise pin a preloaded checkpoint.

Tell the agent: env-file path, reachable Laya URL, selected checkpoints/device,
which providers to test, and the allowed request budget. For quality evaluation,
also supply a JSONL file of representative state/questions and expected labels or
scores, including Hebrew if needed. These smoke scripts establish connectivity
and protocol compatibility; they do not establish accuracy or calibration.

## Offline validation and future integration

`pnpm test` runs protocol, transport, provider and Python service tests with fake
backends. No credentials, model download or GPU are required; the Laya service
contract tests require `python3` on PATH. Laya runs its files serially with one
Vitest worker so Python fixture processes do not overlap. The repository test
runner defaults to two package tasks and two workers per other package; these
limits do not start Docker or load model weights. Package typechecking also compiles test
files and verifies inferred answer types. The Python subprocess has a 20-second
deadline and its enclosing Vitest test allows 25 seconds, so parallel workspace
load does not impose the default five-second limit on the entire Python suite.
The connection-capacity test waits for server-handler cleanup, since reading a
response body does not guarantee its handler has released the connection slot yet.
Publishing order is shared
decision package, core, then provider packages. The shared package publishes a
source-only `/types` entry so core can compile against the same contract before
the core-dependent runtime is built. Core loads that runtime lazily.
Core's test task explicitly waits for the shared runtime build, including on a
fresh checkout without generated files.

Vendor model catalogs, automatic environment provider discovery, chat-specific
decision helpers, and dedicated CLI commands are not introduced here. Generative
models are supported through `classify()`; `decide()` uses decision adapters.

References: [TypeSafe API](https://docs.typesafe.ai/api),
[confidence semantics](https://docs.typesafe.ai/confidence),
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[Laya source](https://github.com/NandhaKishorM/laya),
[Laya benchmarks and limitations](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md).
