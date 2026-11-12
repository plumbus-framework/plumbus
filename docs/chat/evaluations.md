# Chat evaluations

`@plumbus/chat` includes a deterministic evaluation harness: declare scenarios with `defineChatEvaluation`, run them against a scripted model with `runChatEvaluation`, and assert on the events the runtime emits. Evaluations run in the same Vitest invocation as the rest of your tests — no network, no real model, no provider keys.

Exported from `@plumbus/chat/eval` (and from the package root).

## What evaluations assert

Assertions check **runtime behavior via the event stream**: "the runtime emitted a scope-refusal notice", "the turn completed", "the reply was replaced". They never read the prose. To judge what replies say, attach a **judge** — your own code, or a model judge backed by an app prompt (`promptJudge`) — per turn or for the whole conversation (see [Multi-turn and simulated-user scenarios](#multi-turn-and-simulated-user-scenarios)). Deterministic runs use a scripted model; judges and simulated users that call a real model are live runs.

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

A scenario is `{ name, given, when, then: ChatAssertion[], perTurn?, judge? }`. `when` is one of:

- `{ send }` — one turn (the original form);
- `{ turns: [{ send, then?, judge? }, …] }` — a scripted multi-turn conversation;
- `{ simulate: { user, maxTurns, opening? } }` — a simulated user writes each next turn.

Assertions are **plain objects** (`{ type, … }`), not function calls. `then` applies to the single turn, or to the **last** turn of a conversation; `perTurn: { then?, judge? }` applies to every turn.

## Assertion types

The original four shapes keep their original (lenient) semantics, so existing evaluations pass or fail exactly as before:

| Assertion | Checks |
|---|---|
| `{ type: 'expectNoticeEmitted', code }` | A `notice` event with the given `code` was emitted during the turn. |
| `{ type: 'expectInScope', value }` | The turn reached `turn.completed` (i.e. wasn't blocked or failed before completing). The runner asserts completion; it does not branch on the `value` field. |
| `{ type: 'expectRefusalReason', value }` | Accepted by the type but not checked by the runner — it passes unconditionally. To assert a refusal, use `expectNoticeEmitted` with the relevant code (e.g. `chat.out_of_scope`), or inspect the trace (below). |
| `{ type: 'expectGuardFired', name }` | Accepted by the type but not checked by the runner — it passes unconditionally. Inspect the trace to assert guard verdicts. |

Exact assertions (chat 0.4.0-beta.4):

| Assertion | Checks |
|---|---|
| `{ type: 'expectTurnCompleted' }` | The turn reached `turn.completed`. |
| `{ type: 'expectTurnFailed', code? }` | The turn emitted `turn.failed` (with that `code` when given). |
| `{ type: 'expectCompletedInScope', value }` | `turn.completed.inScope === value`. |
| `{ type: 'expectCompletedRefusalReason', value }` | `turn.completed.refusalReason` equals `value` (`null` = no refusal). |
| `{ type: 'expectReplyReplaced', code? }` | A `message.replaced` event (from `validateReply` or a guard rewrite), with that `code` when given. |
| `{ type: 'expectClientActions', count }` | `turn.completed.clientActions` has exactly `count` entries. |

Assertions never read the reply's prose. To judge what a reply says, use a judge (below). For guard verdicts, model output or cited sources, read a `TraceRecorder` (below) with plain Vitest expectations.

## Multi-turn and simulated-user scenarios

```ts
import {
  defineChatEvaluation,
  promptJudge,
  promptUserSimulator,
} from '@plumbus/chat/eval';

export const assistantEval = defineChatEvaluation({
  name: 'assistant',
  chat: assistantChat,
  scenarios: [
    {
      name: 'scripted: a follow-up keeps the thread',
      given: {},
      when: {
        turns: [
          { send: 'How do I export my data?' },
          { send: 'And for last month only?', then: [{ type: 'expectCompletedInScope', value: true }] },
        ],
      },
      perTurn: { then: [{ type: 'expectTurnCompleted' }] },
      then: [{ type: 'expectClientActions', count: 0 }],
    },
    {
      name: 'simulated: a confused user, five turns',
      given: {},
      when: {
        simulate: {
          maxTurns: 5,
          user: promptUserSimulator({
            prompt: 'eval.confusedUser',          // your registered persona prompt
            persona: { goal: 'find out how to export data' },
          }),
        },
      },
      then: [],
      perTurn: { judge: promptJudge({ prompt: 'eval.assistantTurnJudge' }) },
      judge: promptJudge({ prompt: 'eval.assistantConversationJudge', criteria: { standard: '…' } }),
    },
  ],
});
```

- Every turn of a scenario runs on one session: server-persisted chats see their own history; client-persisted chats receive it as `clientHistory`. Pass `sessionIdFor: (scenario) => id` to give each scenario a fresh session.
- `turnInputs: ({ scenario, turnIndex, transcript }) => ({ promptInput?, trustedHistory? })` supplies the server-owned inputs an app builds per turn (what `prepareTurn` gives the HTTP route).
- **Simulated user.** `user({ ctx, transcript, turnIndex })` returns the next message, or `null`/empty to end early. `promptUserSimulator({ prompt, persona? })` backs it with an app-registered prompt: input `{ ...persona, transcript, turnIndex }`, output `{ message: string | null, done?: boolean }`. `opening` fixes the first message.
- **Judges.** A judge is `({ ctx, turn?, transcript }) => { pass, reason? }` — per turn (`perTurn.judge`, a scripted turn's `judge`) or for the whole conversation (`scenario.judge`). `promptJudge({ prompt, criteria? })` backs one with an app-registered prompt: input `{ ...criteria, transcript, turn }` (`turn` is `''` for a conversation judge), output `{ pass: boolean, reason?: string }`. A missing or non-boolean `pass` is a failure. A throwing judge fails the scenario.
- The helpers send the transcript as JSON (`[{ user, assistant }]`) with `<`, `>` and `&` escaped, so your prompt can wrap it in delimiters. Model helpers make real model calls (`serviceArea: 'chat-eval'`); price a live run before running it at scale.
- Each `EvalVerdict` carries `transcript: ChatEvalTurnRecord[]` — per turn `{ index, userMessage, reply, events, completed, failureCode?, inScope?, refusalReason?, clientActions, moderationCode? }`, where `reply` is what the client ends up showing (`message.replaced` applied). Failures name the turn (`turn 2: Assertion failed: …`).

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

`runChatEvaluation(evaluation, ctx, { sessionId, audience, locale, trace?, stores?, sessionIdFor?, turnInputs? })` runs each scenario's turns through the real turn pipeline (`runChatTurn`), collects the emitted events, checks the assertions, and returns one `EvalVerdict` per scenario. `stores` is a `RunChatTurnOpts` forwarded to every turn — pass `{ sessionStore }` to evaluate a chat against injected storage instead of `ctx.data` (see [session-store.md](./session-store.md)):

```ts
interface EvalVerdict {
  scenario: string;
  passed: boolean;
  failures: string[];   // one entry per failed assertion or judge
  transcript?: ChatEvalTurnRecord[];
}
```

`stores` may also carry `validateReply`, so an evaluation exercises the app's reply check. With `mockAI` the same structured output is returned for every turn in the run; script per-turn outputs with your own `AIService` stub for multi-turn scenarios. Since 0.4.0-beta.4 a `trace` records each event once (it was recorded twice). `audience` and `locale` come from the `runChatEvaluation` opts. (Scenario `given` is stored on the definition as documentation of intent; the runner drives `audience` / `locale` from the opts, not from `given`.)

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
- **Answer quality without a judge** — assertions are structural; never assert against frozen output strings. Use a judge for what a reply says.
