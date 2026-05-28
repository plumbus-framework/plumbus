# Chat evaluations

`@plumbus/chat` includes a deterministic evaluation harness: declare scenarios with `defineChatEvaluation`, run them against a scripted model with `runChatEvaluation`, and assert on the events the runtime emits. Evaluations run in the same Vitest invocation as the rest of your tests — no network, no real model, no provider keys.

Exported from `@plumbus/chat/eval` (and from the package root).

## What evaluations assert

Evaluations check **runtime behavior via the event stream**, not answer quality. You assert "the runtime emitted a scope-refusal notice" or "the turn completed" — not "the prose was good." Answer-quality scoring is intentionally out of scope; pair the framework with a separate offline harness if you need that.

## Defining an evaluation

```ts
import { defineChatEvaluation } from '@plumbus/chat/eval';
import { helpChat } from '../chats/help.chat.js';

export const helpChatEval = defineChatEvaluation({
  name: 'help-chat',
  chat: helpChat,
  scenarios: [
    {
      name: 'off-topic question emits a scope refusal notice',
      given: { audience: 'user' },
      when: { send: 'write me a poem about cats' },
      then: [{ type: 'expectNoticeEmitted', code: 'chat.out_of_scope' }],
    },
  ],
});
```

A scenario is `{ name, given, when: { send }, then: ChatAssertion[] }`. Assertions are **plain objects** (`{ type, … }`), not function calls.

## Assertion types

`ChatAssertion` is a union of four shapes. What each one checks today:

| Assertion | Checks |
|---|---|
| `{ type: 'expectNoticeEmitted', code }` | A `notice` event with the given `code` was emitted during the turn. |
| `{ type: 'expectInScope', value }` | The turn reached `turn.completed` (i.e. wasn't blocked or failed before completing). The runner asserts completion; it does not branch on the `value` field. |
| `{ type: 'expectRefusalReason', value }` | Accepted by the type but not checked by the runner — it passes unconditionally. To assert a refusal, use `expectNoticeEmitted` with the relevant code (e.g. `chat.out_of_scope`), or inspect the trace (below). |
| `{ type: 'expectGuardFired', name }` | Accepted by the type but not checked by the runner — it passes unconditionally. Inspect the trace to assert guard verdicts. |

`expectNoticeEmitted` is the fully-wired assertion; `expectInScope` asserts turn completion. To assert on refusal reasons, guard verdicts, model output, or cited sources, read them off a `TraceRecorder` (below) and use plain Vitest expectations.

## Running evaluations

```ts
import { createTestContext, mockAI } from '@plumbus/core/testing';
import { createSession } from '@plumbus/chat';
import { runChatEvaluation } from '@plumbus/chat/eval';
import { helpChatEval } from './help-chat.eval.js';

it('help chat passes its evaluation', async () => {
  const ctx = createTestContext({
    auth: { roles: ['user'] },
    ai: mockAI({
      generate: {
        inScope: false,
        answer: '',
        refusalReason: 'off_topic',
        citedSources: [],
        requestedAction: null,
      },
    }),
  });
  const session = await createSession(ctx, {
    chatName: helpChatEval.chat.name,
    userId: 'u1',
    audience: 'user',
    locale: 'en',
  });

  const results = await runChatEvaluation(helpChatEval, ctx, {
    sessionId: session.id,
    audience: 'user',
    locale: 'en',
  });

  expect(results.every((r) => r.passed)).toBe(true);
});
```

`runChatEvaluation(evaluation, ctx, { sessionId, audience, locale, trace? })` runs each scenario's `when.send` through the real turn pipeline (`runChatTurn`), collects the emitted events, checks the assertions, and returns one `EvalVerdict` per scenario:

```ts
interface EvalVerdict {
  scenario: string;
  passed: boolean;
  failures: string[];   // one entry per failed assertion, with the assertion serialized
}
```

The model is scripted by `mockAI` — the same structured output is returned for every turn in the run. `audience` and `locale` come from the `runChatEvaluation` opts. (Scenario `given` is stored on the definition as documentation of intent; the runner drives `audience` / `locale` from the opts, not from `given`.)

## Tracing a turn

`TraceRecorder` captures what happened inside a turn. Pass one to `runChatEvaluation({ …, trace })` (or to `runChatTurn({ traceRecorder })` directly), then assert on the trace with plain Vitest:

```ts
import { TraceRecorder } from '@plumbus/chat';

const trace = new TraceRecorder();
await runChatEvaluation(helpChatEval, ctx, { sessionId, audience: 'user', locale: 'en', trace });

trace.trace.events          // every ChatEvent emitted, in order
trace.trace.modelOutput     // structured model output: { inScope, answer, refusalReason, citedSources, requestedAction }
trace.trace.guardVerdicts   // [{ name, verdict }] for each guard that ran
trace.trace.resolvedSources // the resolved context sources for the turn
trace.trace.systemPrompt    // the built system prompt
```

This is how you assert things the assertion catalog doesn't cover directly — e.g. `expect(trace.trace.modelOutput?.refusalReason).toBe('off_topic')` or `expect(trace.trace.guardVerdicts.map(g => g.name)).toContain('audience-guard')`.

`mockChatRuntime` (from `@plumbus/chat/testing`) creates and returns a `TraceRecorder` for you — see [testing.md](./testing.md).

## Reference evaluations

The package ships three worked examples in `packages/chat/src/eval/__fixtures__/reference-evaluations.ts`, exercised by `reference-evaluations.test.ts`:

- `audienceFilterEval` — an audience-scoped chat answering an in-scope message.
- `scopeRefusalEval` — an off-topic message producing a `chat.out_of_scope` notice.
- `actionConfirmationEval` — an action-enabled chat.

Use them as templates for your own evaluations.

## What evaluations don't catch

- **Real RAG retrieval quality** — scenarios use scripted providers and mocked context sources, not real embedding similarity.
- **Provider-specific behavior** — streaming quirks, structured-output validation differences, and throttling are all hidden behind `mockAI`.
- **Concurrent-turn races** — behavioral cooldowns under concurrent turns need integration tests against a real Postgres, not scripted unit tests.
- **Answer quality** — by design. Assert structurally over the event stream and trace, not against frozen output strings.
