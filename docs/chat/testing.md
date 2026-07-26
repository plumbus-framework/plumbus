# Testing chats

Four test affordances:

1. **`mockChatRuntime`** for end-to-end turn tests with a scripted provider.
2. **Plumbus core's `createTestContext` + `mockAI`** for unit-testing capabilities, prompts, or context sources in isolation.
3. **Pure helper functions** (`applyChatEvent`, `buildTurnRequestBody`, etc.) for unit-testing UI reducers and request shaping without React.
4. **In-memory stores** (`createInMemoryChatSessionStore`, `createInMemoryChatConversationStore`) for driving the runtime with no database at all.

## End-to-end turn tests with `mockChatRuntime`

```ts
import { describe, it, expect } from 'vitest';
import { defineChat, staticContext } from '@plumbus/chat';
import { mockChatRuntime } from '@plumbus/chat/testing';
import { createTestContext, mockAI } from '@plumbus/core/testing';

const chat = defineChat({
  name: 'help',
  access: { roles: ['user'] },
  context: [staticContext({
    id: 'paths',
    items: [{ id: 'p1', kind: 'text', content: 'Open /project' }],
    sourceId: 'paths-src',
  })],
});

it('emits the expected event sequence for an in-scope question', async () => {
  const { events, trace } = await mockChatRuntime(
    chat,
    {
      sessionId: 'sess-1',
      userMessage: 'how do I create a project?',
      audience: 'user',
      locale: 'en',
    },
    {
      ai: mockAI({
        generate: {
          inScope: true,
          answer: 'Open the [src:src_a] page.',
          refusalReason: null,
          citedSources: ['src_a'],
          requestedAction: null,
        },
      }),
    },
  );

  const types = events.map(e => e.type);
  expect(types[0]).toBe('turn.started');
  expect(types).toContain('source.added');
  expect(types).toContain('message.delta');
  expect(types[types.length - 1]).toBe('turn.completed');

  // Trace assertions
  expect(trace.trace.modelOutput?.inScope).toBe(true);
  expect(trace.trace.guardVerdicts.length).toBeGreaterThan(0);
});
```

`mockChatRuntime` returns `{ ctx, events, trace }`:
- `ctx` is the test execution context (use `ctx.data.ChatTurn?.findMany(...)` to inspect persisted rows).
- `events` is the full event sequence emitted.
- `trace` is the `TraceRecorder` instance — inspect `trace.trace.events`, `trace.trace.modelOutput`, and `trace.trace.guardVerdicts`. See [`evaluations.md`](./evaluations.md) for the full eval harness.

## Scripting different model responses

The `mockAI` helper from `@plumbus/core/testing` accepts a `responses.generate` object that becomes the model output for every turn:

```ts
// In-scope response
mockAI({ generate: { inScope: true, answer: 'OK', refusalReason: null, citedSources: [], requestedAction: null }});

// Refusal
mockAI({ generate: { inScope: false, answer: '', refusalReason: 'off_topic', citedSources: [], requestedAction: null }});

// Action request
mockAI({ generate: {
  inScope: true,
  answer: 'Filing the ticket now.',
  refusalReason: null,
  citedSources: [],
  requestedAction: { capabilityName: 'openTicket', input: { subject: 'help' }, confirmationMessage: 'Open this ticket?' },
}});
```

For multi-turn scenarios where the response should differ per turn, wrap `mockAI` and return different fixtures based on call count. The `countingAI` pattern in `src/runtime/__tests__/run-turn.test.ts` is a good reference.

## Testing budgets, cooldowns, and other stateful behavior

`checkBudgetPreflight` enforces session/user/tenant aggregates — seed prior turns with `appendTurn` / `createSession` helpers (see `packages/chat/src/budget/__tests__/enforcer.test.ts`). Per-turn token/cost caps are exercised through `mockChatRuntime` with usage-heavy `mockAI` responses.

For behavioral cooldowns, seed `ChatSession.behavioralState` with active cooldown keys such as `cooldown:refusal:session:{sessionId}: { until: epochMs }` or counter keys `{trigger}:{session|user}:{id}` with `{ count, windowStart }`:

```ts
const ctx = createTestContext({
  data: {
    ChatSession: [{
      id: 'sess-1',
      chatName: 'help',
      userId: 'u1',
      audience: 'user',
      locale: 'en',
      startedAt: new Date('2026-01-01'),
      lastTurnAt: new Date('2026-01-01'),
      status: 'active',
      behavioralState: {
        'cooldown:refusal:session:sess-1': { until: Date.now() + 30_000 },
      },
      summaryTurnCount: 0,
    }],
  },
});
```

The next turn's pre-turn `behavioral-guard` should emit `chat.cooldown_active`.

## Trust boundary: what tests can and can't prove

| What unit tests CAN prove | What unit tests CANNOT prove |
|---|---|
| Event sequence is correct | The model's answers are good (answer-quality scoring is out of scope) |
| Guards block / allow per policy | The model adheres to the system prompt's voice |
| Pending actions are stored with `schemaHash` | The model's classification of `inScope` is calibrated |
| Context sources resolve in order with stable handles | Real RAG retrieval is finding the right chunks |
| Persistence mode is honored end-to-end | The system prompt scales gracefully across topics |

The [eval harness](./evaluations.md) (`defineChatEvaluation` / `runChatEvaluation`) extends this with deterministic trace assertions over scripted scenarios — still pipeline-correctness, not answer-quality.

## Testing UI helpers without React

`@plumbus/chat-ui` exports two pure helpers that should be tested without rendering:

```ts
import { applyChatEvent, buildTurnRequestBody, initialChatUiState } from '@plumbus/chat-ui';

it('client-persistence sends clientHistory capped at 20', () => {
  const body = buildTurnRequestBody({
    sessionId: 's1', userMessage: 'new', audience: 'user', locale: 'en',
    persistence: 'client',
    currentMessages: longHistory,
  });
  expect(body.clientHistory).toHaveLength(20);
});
```

The hook itself is a thin reducer wrapper — test the reducer, trust React.

## Test patterns to copy from the repo

| Pattern | File |
|---|---|
| Counting AI calls (regression guard for double-charge bug) | `src/runtime/__tests__/run-turn.test.ts` `countingAI` helper |
| Stable source-handle assertions | same file, "cited-sources persistence" suite |
| Persistence-mode round-trip | same file, "persistence modes" suite |
| Trace recorder coverage | same file, "trace recorder" suite |
| Pure helper coverage | `packages/chat-ui/src/hooks/__tests__/useChat-helpers.test.ts` |
| Tool-calling loop + confirm/resume | `packages/chat/src/runtime/__tests__/run-turn-tools.test.ts` |
| Lease store conformance | `packages/chat/src/runtime/__tests__/conversation-store.test.ts` |
| Injected session store, no `ctx.data` | `packages/chat/src/session/__tests__/session-store-injection.test.ts` |
| Injected session store over HTTP routes | `packages/chat/src/runtime/__tests__/http-session-store.test.ts` |

## Testing a session store adapter

`createInMemoryChatSessionStore` from `@plumbus/chat/testing` drives the whole pipeline
with no database:

```ts
import { createInMemoryChatSessionStore } from '@plumbus/chat/testing';

const sessionStore = createInMemoryChatSessionStore();
for await (const evt of runChatTurn(ctx, args, { sessionStore })) {
  events.push(evt);
}
expect(sessionStore.__turns.map((t) => t.ordinal)).toEqual([0, 1]);
```

To prove your own adapter is genuinely free of `ctx.data`, run a turn against a context
whose `data` throws on every property access. Copy the `contextWithoutData` helper from
`packages/chat/src/session/__tests__/session-store-injection.test.ts`; asserting only on
the event stream would pass even if the pipeline silently fell back to repositories.

See [session-store.md](./session-store.md) for the adapter contract itself.

## Testing tool calling (Path B)

Script tool rounds through `mockAI` by returning an assistant message whose `toolCalls`
carry `argumentsStatus: 'parsed'` for the first call(s) and a final tool-less answer for
the last round. Assert on the tool event sequence (`tool.started` → `tool.completed` /
`tool.failed`) and, for confirm-mode tools, on `confirmation_required` followed by
`confirmation.resolved` after driving `POST /chat/:name/confirm`. Path B needs a
transactional store; use the in-suite `ChatConversationStore` conformance fixture rather
than the plain in-memory repository (which fails closed with `chat.storage_unsupported`).
