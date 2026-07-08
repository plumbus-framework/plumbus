# Testing Chats — Agent Recipe

Three test affordances:

1. **`mockChatRuntime`** for end-to-end turn tests with a scripted provider.
2. **`createTestContext` + `mockAI`** from `@plumbus/core/testing` for unit-testing chats with full control.
3. **Pure helpers** from `@plumbus/chat-ui` (`applyChatEvent`, `buildTurnRequestBody`) for UI reducer tests without React.

## End-to-end turn test (the default)

```ts
import { describe, it, expect } from 'vitest';
import { mockChatRuntime } from '@plumbus/chat/testing';
import { mockAI } from '@plumbus/core/testing';
import { defineChat, staticContext } from '@plumbus/chat';

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

  const types = events.map((e) => e.type);
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

- `ctx` — the test execution context. Use `ctx.data.ChatTurn?.findMany(...)` to inspect persisted rows.
- `events` — the full event sequence emitted.
- `trace` — the `TraceRecorder`. Has `resolvedSources`, `systemPrompt`, `modelOutput`, `guardVerdicts`, `events`.

## Scripting different model responses

```ts
// In-scope response
mockAI({ generate: { inScope: true, answer: 'OK', refusalReason: null, citedSources: [], requestedAction: null } });

// Refusal
mockAI({ generate: { inScope: false, answer: '', refusalReason: 'off_topic', citedSources: [], requestedAction: null } });

// Action request
mockAI({ generate: {
  inScope: true,
  answer: 'Filing the ticket now.',
  refusalReason: null,
  citedSources: [],
  requestedAction: { capabilityName: 'openTicket', input: { subject: 'help' }, confirmationMessage: 'Open this ticket?' },
}});
```

For multi-turn tests where responses should vary by call, wrap `mockAI` manually. The `countingAI` pattern in `src/runtime/__tests__/run-turn.test.ts` is a copy-paste reference.

## Testing budgets and cooldowns

`checkBudgetPreflight` throws `chat.budget_exceeded` when session/user/tenant aggregates cross configured caps. Per-turn token/cost caps fail the turn after generation. Seed prior turns via `appendTurn` / `createSession` helpers.

For behavioral cooldowns, seed `ChatSession.behavioralState` with keys like `cooldown:refusal:session:{sessionId}` (`{ until: epochMs }`) or counter keys `{trigger}:{scopeKey}` with `{ count, windowStart }`. See `packages/chat/src/budget/__tests__/enforcer.test.ts` and `src/runtime/__tests__/run-turn.test.ts` for budget/cooldown examples.

## Pure UI helpers (no React needed)

`@plumbus/chat-ui` exports `applyChatEvent` and `buildTurnRequestBody`:

```ts
import {
  applyChatEvent,
  buildTurnRequestBody,
  initialChatUiState,
} from '@plumbus/chat-ui';

it('client-persistence sends clientHistory capped at 20', () => {
  const body = buildTurnRequestBody({
    sessionId: 's1',
    userMessage: 'new',
    audience: 'user',
    locale: 'en',
    persistence: 'client',
    currentMessages: longHistory,
  });
  expect(body.clientHistory).toHaveLength(20);
});
```

The hook (`useChat`) is a thin reducer wrapper — test the reducer, trust React.

## Do's

- **Do** always use `mockChatRuntime` for end-to-end turn tests. Spinning up a real provider is unnecessary and flaky.
- **Do** assert against the trace, not against string snapshots. Snapshots break every time the prompt builder changes.
- **Do** write at least one happy-path + one refusal test for every chat.
- **Do** test persistence-mode-specific behavior in client and server modes separately — they hit different code paths.
- **Do** use `countingAI` (from `src/runtime/__tests__/run-turn.test.ts`) when you need to verify a turn made exactly N model calls.

## Don'ts

- **Don't** snapshot full event sequences as strings. Assert structurally (`expect(types).toContain('turn.started')`).
- **Don't** use real provider keys in tests. Always go through `mockAI`.
- **Don't** seed `ChatTurn` rows manually without setting `ordinal` — the in-memory test layer doesn't auto-increment.
- **Don't** assume every eval assertion is enforced. `defineChatEvaluation` / `runChatEvaluation` exist, but only `expectNoticeEmitted` is fully wired (and `expectInScope` asserts turn-completion); `expectRefusalReason` and `expectGuardFired` are accepted but not checked — assert those off the `TraceRecorder`. See `/docs/chat/evaluations.md`.

## Trust Boundary

| What unit tests CAN prove | What unit tests CANNOT prove |
|---|---|
| Event sequence is correct | The model's answers are good |
| Guards block / allow per policy | The model adheres to the system prompt's voice |
| Pending actions stored with `schemaHash` | The model's classification of `inScope` is calibrated |
| Context sources resolve in order with stable handles | Real RAG retrieval is finding the right chunks |
| Persistence mode is honored end-to-end | The system prompt scales gracefully across topics |

For answer-quality eval you need a separate offline harness — the eval framework (`runChatEvaluation`) proves pipeline-correctness, not model-judge.

## Deeper Reference

- `/docs/chat/testing.md` — full conceptual reference
- `src/runtime/__tests__/run-turn.test.ts` — 11 reference tests including `countingAI` pattern
- `src/testing/mock-chat-runtime.ts` — the helper itself (read before writing alternatives)
