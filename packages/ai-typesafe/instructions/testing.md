# Testing decisions

**Exact path in a consumer app:** `node_modules/@plumbus/ai-typesafe/instructions/testing.md`

**Never call the live TypeSafe API from a unit test.** Decisions are cheap but not free, they need a key in CI, and their answers move between model versions — a test that calls the real endpoint fails for reasons that have nothing to do with your code. Pick the layer you actually need to exercise.

| You are testing | Use |
|---|---|
| A capability handler's branching on answers | `createTestContext({ ai: { decide } })` |
| The AI service path: cost rows, budgets, explainability | `createStubDecisionAdapter` |
| This package's own request/response mapping | A stub `TypeSafeClient` via `config.client` |
| That your key and questions work against the real model | A key-gated smoke script, outside the unit suite |

---

## Capability tests — `mockAI` via `createTestContext`

`ctx.ai.decide` is mocked for you. Stub the answers you assert on; anything omitted gets a deliberately **undecided** default for its question type — noul `0.5`, the first option of a choice, the middle level of a score, each with a uniform distribution and low confidence.

```typescript
import { createTestContext, describe, expect, it, mockEvents } from '@plumbus/core/testing';
import { triageTicket } from '../app/capabilities/triageTicket.js';

describe('triageTicket', () => {
  it('escalates an urgent, angry ticket', async () => {
    const events = mockEvents();
    const ctx = createTestContext({
      events,
      ai: {
        decide: {
          isUrgent: { type: 'noul', noul: 0.97 },
          department: {
            type: 'choice',
            choice: 'billing',
            probabilities: { billing: 0.9, technical: 0.1 },
            confidence: 0.85,
          },
          frustration: {
            type: 'score',
            score: 1.9,
            legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
            probabilities: { '0': 0, '1': 0.1, '2': 0.9 },
            confidence: 0.9,
          },
        },
      },
      data: { Ticket: [{ id: 'ticket-1', subject: 'Payouts failing', body: 'Third day now.' }] },
    });

    const result = await triageTicket.handler(ctx, { ticketId: 'ticket-1' });

    expect(result.escalated).toBe(true);
    expect(events.emitted).toContainEqual({
      eventName: 'ticket.escalated',
      payload: expect.objectContaining({ ticketId: 'ticket-1' }),
    });
  });
});
```

The low-confidence defaults are deliberate. A handler that forgets to gate on confidence fails the test instead of coasting on a fake certainty.

### Always test the low-confidence branch

This is the test people skip and then regret.

```typescript
it('sends a low-confidence routing decision to human review', async () => {
  const ctx = createTestContext({
    ai: {
      decide: {
        department: {
          type: 'choice',
          choice: 'billing',
          probabilities: { billing: 0.45, technical: 0.42, sales: 0.13 },
          confidence: 0.38,
        },
      },
    },
    data: { Ticket: [{ id: 'ticket-1', subject: 'Hmm', body: 'Something is off.' }] },
  });

  await triageTicket.handler(ctx, { ticketId: 'ticket-1' });

  const ticket = await ctx.data.Ticket.findById('ticket-1');
  expect(ticket.status).toBe('needs_human_review');
});
```

Note the answer still says `billing` — the top option is present and plausible. Only `confidence` distinguishes this case, which is exactly why the branch needs its own test.

---

## Service tests — `createStubDecisionAdapter`

To exercise the whole framework path — budget pre-check, cost recording, explainability — register a stub adapter instead of mocking `ctx.ai`.

```typescript
import { createAIService, createCostTracker, noul } from '@plumbus/core';
import { createStubDecisionAdapter } from '@plumbus/core/testing';

const adapter = createStubDecisionAdapter({
  answers: { isUrgent: { type: 'noul', noul: 0.95 } },
  inputTokens: 300,
  cost: 0.0000126,
});

const ai = createAIService({
  providers: { mock: mockTextProvider },
  defaultProvider: 'mock',
  decisionProviders: { stub: adapter },
  defaultDecisionProvider: 'stub',
  costTracker: createCostTracker({ dailyCostLimit: 1 }),
});

const result = await ai.decide({ state: 'x', questions: { isUrgent: noul('Urgent?') } });

expect(result.cost).toBe(0.0000126);
expect(adapter.requests[0]?.state).toBe('x');
```

A question with no stubbed answer **throws**, so adding a question without an expectation fails loudly rather than quietly asserting on a placeholder.

Use `error` to exercise failure paths, including that a failed call still records a ledger row:

```typescript
const failing = createStubDecisionAdapter({
  answers: {},
  error: new Error('provider exploded'),
});
```

---

## Adapter tests — stub the SDK client

Only needed if you are testing this package's own mapping. Pass `config.client`; every other connection field is then ignored, so no key is read and no network call is possible.

```typescript
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';
import type { TypeSafeClient } from '@typesafe-ai/sdk';

const client = {
  systemOne: async () => ({
    model: 'jev-1.13.0',
    answers: { isUrgent: { type: 'noul', noul: 0.95 } },
    // note: the wire shape is snake_case; the adapter normalizes it
    usage: { input_tokens: 300, output_tokens: 20 },
  }),
  models: { list: async () => [] },
} as unknown as TypeSafeClient;

const adapter = createTypeSafeDecisionAdapter({ client });

const response = await adapter.decide({
  state: 'x',
  questions: { isUrgent: { type: 'noul', instructions: 'Urgent?' } },
});

expect(response.usage).toEqual({ inputTokens: 300, outputTokens: 20, totalTokens: 320 });
```

The same `client` field works on `createTypeSafeAdapter` for the native `classify` hook. Remember it generates positional question ids (`label_0`, `label_1`, …) in label order, so a stub must answer those keys.

---

## Live smoke tests

Keep real calls out of the unit suite and behind a key check, so a contributor without a TypeSafe account can still run `pnpm test`.

```typescript
import { describe, it } from 'vitest';

const hasKey = Boolean(process.env.TYPESAFE_API_KEY ?? process.env.AI_TYPESAFE_API_KEY);

describe.skipIf(!hasKey)('typesafe live', () => {
  it('answers a noul', async () => {
    // real createTypeSafeDecisionAdapter() call
  });
});
```

Assert on **structure and ranges**, not exact probabilities. `expect(answer.noul).toBeGreaterThan(0.7)` survives a model upgrade; `toBe(0.95)` does not.

The monorepo ships one: `examples/ai-typesafe-smoke`.

---

## Governance tests

The decision rules ship in `aiRules` and read `inventory.decisions`. They are **not** in `plumbus verify`'s built-in rule set — like the existing prompt rules, you register them yourself, which is what makes a governance test the right home for them:

```typescript
import { aiRules } from '@plumbus/core';
import { assertNoGovernanceSignal, emptyInventory, evaluateGovernance } from '@plumbus/core/testing';
import { triageTicket } from '../app/decisions/triage.js';

const result = evaluateGovernance(aiRules, emptyInventory({ decisions: [triageTicket] }));

assertNoGovernanceSignal(result, [
  'ai.decision-missing-state-schema',
  'ai.decision-noul-missing-criteria',
]);
```

| Rule | Severity | Fires when |
|---|---|---|
| `ai.decision-missing-state-schema` | Warning | No `state` schema on the contract |
| `ai.decision-noul-missing-criteria` | Info | A noul question has no `criteria` |
| `ai.decision-missing-model-config` | Info | No model pinned, so a moving alias answers |

---

## Checklist

- [ ] No unit test reaches the network
- [ ] The **low-confidence** branch of every gated decision has its own test
- [ ] Assertions are on ranges and structure, not exact probabilities
- [ ] Failure-path tests cover a throwing provider, not just the happy path
- [ ] Live calls live in a `describe.skipIf(!hasKey)` smoke script outside the unit suite
- [ ] A governance test registers `aiRules` over your decisions (see above) and is clean of signals you did not consciously accept
