# Chat evaluations (preview — v0.2)

> **Status:** the eval framework lives in `src/eval/` but is **not** part of the v0.1 release. It will ship in v0.2 once at least one real consumer has stressed the v0.1 runtime in production. Reference scenarios authored before real failures are speculative; the v0.2 gate exists to make the eval suite actually useful. Treat the API below as unstable until tagged.

## Why deterministic-only evals

V0.1 of the eval framework asserts **runtime behavior**, not **answer quality**. Model-judge evaluation (an LLM scoring another LLM's output) is noisy, expensive, and prone to drifting in unpredictable ways. Trace assertions are cheap, deterministic, and force the runtime to make the right things observable.

| Eval style | What it tests | When you reach for it |
|---|---|---|
| **Trace-based** (v0.2) | "Was the capability called? Is provenance present? Did the right guard fire?" | Every CI run. Cheap, fast, reliable. |
| **Model-judge** (not in v0.1 or v0.2) | "Was the answer well-phrased?" | Out of scope. Use a separate offline harness. |
| **Snapshot** (anti-pattern here) | "Exact string match against frozen output" | Don't. Prompt-builder churn would invalidate every snapshot. Assert structurally over the trace instead. |

## API shape (preview)

```ts
import { defineChatEvaluation } from '@plumbus/chat/eval';

export const helpChatEvals = defineChatEvaluation({
  name: 'help-chat',
  chat: helpChat,
  scenarios: [
    {
      name: 'admin-only source not served to a user',
      given: {
        audience: 'user',
        locale: 'en',
        mockedSources: [
          { id: 'admin-doc', metadata: { audience: 'admin' }, content: 'secret' },
          { id: 'user-doc',  metadata: { audience: 'user' },  content: 'public' },
        ],
      },
      when: { send: 'how do I do X?' },
      then: [
        expectInScope(true),
        expectCitesSource('user-doc'),
        expectGuardFired('audience-guard'),
      ],
    },
    {
      name: 'off-topic question emits localized refusal notice',
      given: { audience: 'user', locale: 'he' },
      when: { send: 'what is the weather?' },
      then: [
        expectInScope(false),
        expectRefusalReason('off_topic'),
        expectNoticeEmitted('chat.out_of_scope'),
      ],
    },
    {
      name: 'action request requires confirmation',
      given: { audience: 'user', locale: 'en' },
      when: { send: 'open a support ticket' },
      then: [
        expectActionRequested('openSupportTicket'),
      ],
    },
  ],
});
```

## Assertion catalog

All assertions read from `TraceRecorder.trace`:

| Assertion | Reads from | Notes |
|---|---|---|
| `expectInScope(true \| false)` | `trace.modelOutput.inScope` | |
| `expectRefusalReason(reason)` | `trace.modelOutput.refusalReason` | |
| `expectCitesSource(sourceId)` | `trace.modelOutput.citedSources` after provenance guard | Already validated against runtime handles |
| `expectGuardFired(name)` | `trace.guardVerdicts` | Match by guard function name |
| `expectActionRequested(capName)` | `trace.modelOutput.requestedAction.capabilityName` | |
| `expectNoticeEmitted(code)` | `trace.events.filter(e => e.type === 'notice').map(e => e.code)` | |
| `expectBudgetRespected()` | `trace.events.some(e => e.type === 'turn.completed')` AND no `budget_exceeded` notice | |

## What evals don't catch

- **Real RAG retrieval quality.** Scenarios use scripted providers and mocked context sources. They don't exercise actual embedding similarity.
- **Provider-specific behavior.** Streaming inconsistencies, structured-output validation differences, throttling — all hidden behind `mockAI`.
- **Concurrent turn races.** Behavioral cooldowns under concurrent turns need integration tests against real PG, not scripted unit tests.
- **Answer quality.** A regressed answer that still says the right keywords passes `responseIncludes`. Documented gap.

The v0.2 reference suite (3 scenarios as of preview) intentionally covers only the most cross-cutting pipeline guarantees: audience filter, scope refusal, action confirmation. The plan is to expand once MemoirAI (or another real consumer) surfaces actual production failures during v0.1 migration.

## Where evals fit in CI

Run them in the same Vitest invocation as unit tests — no separate harness. They're trace-based, so they need no network, no real model, no provider keys. The whole suite finishes in milliseconds.

## Roadmap

| Version | Eval surface |
|---|---|
| v0.1 (current) | Not exposed. The framework exists in `src/eval/` for development but is not stable API. |
| v0.2 (preview) | `defineChatEvaluation` + 3 reference scenarios + `mockChatRuntime`. Expand reference set after first real consumer migration. |
| Later | Possibly model-judge integration. Possibly an integration runner that hits real RAG. Both depend on demand. |
