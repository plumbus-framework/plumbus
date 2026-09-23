# Typed decision provider packages

This release implements the provider packages only. Core is unchanged: there is no
`ctx.ai.decide()`, `defineDecision()`, decision registry, environment discovery, or
automatic decision budget/audit integration yet. Do not register these adapters in
`createAIService({ providers })`: that registry expects completion adapters.

| Package | Responsibility |
| --- | --- |
| `@plumbus/ai-decision` | Shared types, runtime validation, structured errors, bounded HTTP transport |
| `@plumbus/ai-decision-typesafe` | TypeSafe/Jev System One adapter and model-specific input pricing |
| `@plumbus/ai-decision-laya` | Laya HTTP adapter and a separately deployed Python reference service |

All three packages start at `0.2.0` and peer on core `0.7.x`. The provider packages
depend on the shared package; neither depends on the other. Node.js 20.6+ is
required. Only the Laya service needs Python/model dependencies. The TypeSafe
adapter calls the documented HTTP endpoint directly, using the shared transport;
consumer apps do not need a vendor SDK.

For the researched issue matrix, regressions and local HTTP end-to-end coverage,
see the [58-scenario first audit](decision-provider-audit.md).

## Contract

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
create global clients or implement a competing workflow runtime. Native execution
context integration is deferred. Direct adapter calls do not enforce core's PII
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
Neither adapter automatically writes to the core cost tracker. Integrating a
native `decide` operation into budgets and billing remains core work.

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
503 before another handler thread starts. Client disconnects during headers or
body writes are handled without escaping the request handler.

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
keeps the server running after the smoke test.

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
contract tests require `python3` on PATH. Package typechecking also compiles test
files and verifies inferred answer types. Publishing order is core, shared
decision package, then provider packages.

Deferred core work: `ctx.ai.decide()`, named decision definitions, bootstrap and
worker registration, identity/security/budget/audit integration, flow cancellation
wrappers, mock AI, agent discovery, and optional chat/voice convenience helpers.
No existing `classify()` semantics change in this release.

References: [TypeSafe API](https://docs.typesafe.ai/api),
[confidence semantics](https://docs.typesafe.ai/confidence),
[Jev limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13),
[Laya source](https://github.com/NandhaKishorM/laya),
[Laya benchmarks and limitations](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md).
