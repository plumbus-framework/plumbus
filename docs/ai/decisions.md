# Typed Decisions (`ctx.ai.decide`)

> Ask a model typed questions about a state and get back one typed answer per question, with calibrated probabilities. Your code decides what to do; the model never returns free text you have to parse.

This page covers the **decision primitive** in `@plumbus/core`: `defineDecision`, `ctx.ai.decide`, the three question types, and how to route on confidence. For the provider that answers these questions today, see [TypeSafe / Jev (`@plumbus/ai-typesafe`)](./typesafe.md). For prompts, generation, and RAG, see [AI Integration](./ai-integration.md).

---

## Table of contents

1. [Why a separate primitive](#why-a-separate-primitive)
2. [Decision vs prompt — which do I want?](#decision-vs-prompt--which-do-i-want)
3. [Install a decision provider](#install-a-decision-provider)
4. [Question types](#question-types)
5. [Calling `ctx.ai.decide`](#calling-ctxaidecide)
6. [Decision contracts (`defineDecision`)](#decision-contracts-definedecision)
7. [Structured instructions](#structured-instructions)
8. [Confidence and routing](#confidence-and-routing)
9. [Ask many questions at once](#ask-many-questions-at-once)
10. [Environment variables](#environment-variables)
11. [Cost, budgets, and the ledger](#cost-budgets-and-the-ledger)
12. [Explainability and audit](#explainability-and-audit)
13. [Governance rules](#governance-rules)
14. [Native `classify`](#native-classify)
15. [Testing decisions](#testing-decisions)
16. [Writing your own decision adapter](#writing-your-own-decision-adapter)
17. [Gotchas (read this)](#gotchas-read-this)
18. [Checklist before production](#checklist-before-production)

---

## Why a separate primitive

A chat model answers a question by generating text. To use that answer in code you prompt for JSON, validate it, retry when it drifts, and then discard the model's own uncertainty, because a sampled token stream does not tell you how close the call was.

A decision model works the other way round: it takes a `state` and a map of typed questions, and returns a probability distribution per question. There is nothing to parse and nothing to repair, and the distribution is the answer's own uncertainty, which your code can branch on.

That does not fit `AIProviderAdapter`, which is built around `complete` / `stream` / `embed`. A decision model has no chat turns, no token stream, and no embeddings. So decisions get their own provider interface (`DecisionProviderAdapter`), registered in their own slot, reached through `ctx.ai.decide`.

```
@plumbus/core                            @plumbus/ai-typesafe
─────────────                            ────────────────────
ctx.ai.generate / streamGenerate  ──►    (unsupported — throws)
  AIProviderAdapter                      OpenAI / Anthropic / Bedrock handle text

ctx.ai.decide                     ──►    createTypeSafeDecisionAdapter
  DecisionProviderAdapter                POST /v1/systemone

ctx.ai.classify                   ──►    createTypeSafeAdapter
  AIProviderAdapter.classify hook        one noul per label, one request
```

Everything else in the AI runtime is shared. `decide()` goes through the same prompt-security scan, the same budget pre-check, the same cost ledger, and the same explainability tracker as `generate()`.

---

## Decision vs prompt — which do I want?

| You want | Use |
|---|---|
| Route a ticket to one of five teams | `decide()` with a Choice |
| Decide whether a message is urgent | `decide()` with a Noul |
| Rate a resume against a rubric | `decide()` with a Score |
| Know how certain the model was | `decide()` — prompts do not report calibrated confidence |
| Tag content with several labels at once | `decide()` with one Noul per label, or `ctx.ai.classify()` |
| Draft an email, summarize a document, write code | `definePrompt` + `ctx.ai.generate` |
| Pull structured fields out of a document | `ctx.ai.extract` (or `decide()` when the value is from a closed set) |
| Answer a question from a corpus | `ctx.ai.retrieve` + `generate` (RAG) |

The rule of thumb: if the output space is **closed** — a yes/no, one of a known set, a level on a rubric — it is a decision. If the output is **open** text, it is a prompt.

A common shape is both at once: `decide()` to pick the handler, then `generate()` inside the branch that needs prose.

---

## Install a decision provider

Core ships the primitive; the provider is an optional add-on. Without one, `ctx.ai.decide()` throws with the env var and install command in the message.

```bash
pnpm add @plumbus/ai-typesafe
```

```bash
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe
AI_DECISION_MODEL=jev-latest
```

Or wire it programmatically:

```typescript
import { createAIService, createOpenAIAdapter } from '@plumbus/core';
import { createTypeSafeDecisionAdapter } from '@plumbus/ai-typesafe';

const ai = createAIService({
  providers: { openai: createOpenAIAdapter({ apiKey: process.env.AI_OPENAI_API_KEY! }) },
  defaultProvider: 'openai',
  decisionProviders: {
    typesafe: createTypeSafeDecisionAdapter({ apiKey: process.env.AI_TYPESAFE_API_KEY! }),
  },
  defaultDecisionProvider: 'typesafe',
  defaultDecisionModel: 'jev-latest',
});
```

Decision providers are a **separate default** from `defaultProvider`. Running OpenAI for `generate()` and TypeSafe for `decide()` in the same app is the normal configuration, not a special case.

After installing on an existing app, refresh agent wiring so coding agents find the package instructions:

```bash
plumbus init --patch --agent agents-md
plumbus doctor
```

---

## Question types

Three types, all sharing `type` and `instructions`. Each adds its own `criteria`. Build them with the `noul` / `choice` / `score` helpers from `@plumbus/core`.

### Noul — yes/no

Returns the probability that the answer is yes, from `0` to `1`.

```typescript
import { noul } from '@plumbus/core';

noul('Does this message convey urgency?', {
  true: 'Explicitly time-sensitive',
  false: 'No urgency expressed',
});
```

```typescript
// answer
{ type: 'noul', noul: 0.95 }
```

`criteria` is optional but you should almost always supply it. Without it the boundary between yes and no is left entirely to the model, which is the most common cause of a probability that does not mean what you assumed. Core's governance rules flag noul questions that omit it.

### Choice — one of a set

Returns the highest-probability option, the full distribution, and a confidence figure.

```typescript
import { choice } from '@plumbus/core';

choice('Which team should handle this ticket?', {
  billing: 'Payments, invoicing, refunds',
  technical: 'Bugs, outages, integrations',
  sales: 'Pricing, upgrades, new accounts',
});
```

```typescript
// answer
{
  type: 'choice',
  choice: 'billing',
  probabilities: { billing: 0.88, technical: 0.12, sales: 0.0 },
  confidence: 0.81,
}
```

Use `null` for an option that needs no rubric. The option keys are yours, so `answers.department.choice` narrows to exactly those literals — a typo in a downstream comparison is a compile error, not a silent `false`.

A Choice accepts at most **255** options.

### Score — a level on a rubric

Returns a probability-weighted value across your ordered levels. The value can land **between** levels, which is the point: it carries how far along the rubric the state sits, not just the nearest label.

```typescript
import { score } from '@plumbus/core';

score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry']);
```

```typescript
// answer
{
  type: 'score',
  score: 1.05,
  legend: { '0': 'Calm', '1': 'Frustrated', '2': 'Very angry' },
  probabilities: { '0': 0.0, '1': 0.95, '2': 0.05 },
  confidence: 0.92,
}
```

Levels are ordered, lowest first, and there must be between **2** and **10** of them.

> Both limits are checked at `defineDecision()` time and again before any network I/O, so a bad rubric fails locally with the offending question id instead of as a provider `422`.

---

## Calling `ctx.ai.decide`

```typescript
import { defineCapability, choice, noul, score } from '@plumbus/core';
import { z } from 'zod';

export const triageTicket = defineCapability({
  name: 'triageTicket',
  kind: 'action',
  domain: 'support',
  description: 'Route an inbound support ticket and gauge its temperature',

  input: z.object({ ticketId: z.string().uuid() }),
  output: z.object({ department: z.string(), escalated: z.boolean() }),

  access: { roles: ['agent'], tenantScoped: true },
  effects: { data: ['Ticket'], events: ['ticket.escalated'], external: [], ai: true },
  explanation: { enabled: true },

  handler: async (ctx, input) => {
    const ticket = await ctx.data.Ticket.findById(input.ticketId);
    if (!ticket) throw ctx.errors.notFound('Ticket not found');

    const { answers, usage, cost } = await ctx.ai.decide({
      state: { subject: ticket.subject, body: ticket.body },
      questions: {
        isUrgent: noul('Does this convey urgency?', {
          true: 'Explicitly time-sensitive',
          false: 'No urgency expressed',
        }),
        department: choice('Which team should handle this?', {
          billing: 'Payments, invoicing, refunds',
          technical: 'Bugs, outages, integrations',
          sales: 'Pricing, upgrades, new accounts',
        }),
        frustration: score('How frustrated is the customer?', [
          'Calm',
          'Frustrated',
          'Very angry',
        ]),
      },
    });

    // Plain code from here. No parsing, no schema repair.
    const escalated = answers.isUrgent.noul > 0.9 && answers.frustration.score > 1.5;
    if (escalated) {
      await ctx.events.emit('ticket.escalated', { ticketId: ticket.id });
    }

    await ctx.data.Ticket.update(ticket.id, {
      department: answers.department.choice,
      urgencyScore: answers.isUrgent.noul,
    });

    ctx.logger.info('Triaged ticket', { tokens: usage.inputTokens, cost });

    return { department: answers.department.choice, escalated };
  },
});
```

`answers` is keyed by the ids you chose, and each value narrows to the answer variant its question produces — `answers.isUrgent.noul` is a `number`, `answers.department.choice` is `'billing' | 'technical' | 'sales'`. The keys are **not** sent to the model and play no part in inference; name them for your code's benefit.

### Config reference

| Field | Purpose |
|---|---|
| `state` | The content to evaluate. A string for text, or an object/array for records, chat logs, or application state. |
| `questions` | Inline question map. Mutually exclusive with `decision`. |
| `decision` | A `defineDecision()` contract, or its name when a registry is wired. Mutually exclusive with `questions`. |
| `provider` | Per-call decision provider override. |
| `model` | Per-call model override, e.g. pin `'jev-1.13.0'` instead of an alias. |
| `signal` | Abort the in-flight request. Defaults to `ctx.signal` inside flow steps. |
| `costContext` | Per-call billing metadata forwarded to the `onAICostRecorded` hook. |

### Result reference

| Field | Purpose |
|---|---|
| `model` | The **versioned** model id that answered. An alias resolves here, so log it. |
| `answers` | One answer per question, under the same keys. |
| `usage` | `inputTokens`, `outputTokens`, `totalTokens`. |
| `cost` | USD for this call, or `null` when no rate is known. |

---

## Decision contracts (`defineDecision`)

Inline questions are right for a one-off. A decision reused across capabilities, or one whose thresholds you tune, belongs in a contract under `app/decisions/`, next to `app/prompts/`.

```typescript
// app/decisions/triage.ts
import { choice, defineDecision, noul, score } from '@plumbus/core';
import { z } from 'zod';

export const triageTicket = defineDecision({
  name: 'support.triageTicket',
  description: 'Route an inbound support ticket and gauge its temperature',
  domain: 'support',
  owner: 'support-platform',
  state: z.object({ subject: z.string(), body: z.string() }),
  questions: {
    isUrgent: noul('Does this convey urgency?', {
      true: 'Explicitly time-sensitive',
      false: 'No urgency expressed',
    }),
    department: choice('Which team should handle this?', {
      billing: 'Payments, invoicing, refunds',
      technical: 'Bugs, outages, integrations',
      sales: 'Pricing, upgrades, new accounts',
    }),
    frustration: score('How frustrated is the customer?', ['Calm', 'Frustrated', 'Very angry']),
  },
  // Pin a version once thresholds are tuned against it.
  model: { name: 'jev-1.13.0' },
});
```

```typescript
const { answers } = await ctx.ai.decide({
  decision: triageTicket,
  state: { subject: ticket.subject, body: ticket.body },
});
```

A contract buys you four things:

- **The state is parsed** against its Zod schema before any network call, so a contract drift fails locally instead of producing a confident answer about the wrong shape.
- **Structural limits are checked at import**, not on first call in production.
- **Env overrides apply** — `DECISION_SUPPORT_TRIAGETICKET_MODEL` re-points it without a deploy.
- **Governance can see it**, and the explainability record carries its name.

Files in `app/decisions/` are auto-discovered by `plumbus dev`, `plumbus start`, and `plumbus worker`, and registered in a `DecisionRegistry`. That is what lets you pass a name instead of the object:

```typescript
await ctx.ai.decide({ decision: 'support.triageTicket', state });
```

### Resolution order

Provider and model are resolved per call, in this order:

```
call argument → DECISION_{NAME}_* env → contract `model` → AI_DECISION_MODEL / AI_DECISION_PROVIDER
```

Note what is **not** configurable: there is no `temperature` or `maxTokens` on a `DecisionModelConfig`. A decision model returns a calibrated distribution rather than sampled text, so the knobs that shape generation have nothing to act on. You shape answers through `instructions` and `criteria` instead.

---

## Structured instructions

`instructions` accepts a string, an object, or an array. Reach for structure when a question has to reference data: put the question in one field, the data in the others, and refer to the data fields by name in backticks.

```typescript
noul({
  potential_duplicate: {
    name: 'John Smith',
    location: 'Oakland, California',
    last_employer: 'Google',
  },
  question: 'Is the resume for the same person as `potential_duplicate`?',
});
```

This keeps a long question readable and keeps its data out of the `state`, which matters when the `state` is a large document you want evaluated as a whole.

---

## Confidence and routing

Choice and Score answers carry `confidence` derived from the distribution. It is a **different axis** from the answer itself:

- The **answer** tells you *what* the model concluded.
- **Confidence** tells you *whether you should act on it*.

An 80% / 20% split and a 45% / 42% / 13% split can both have `billing` on top. Only the second one should reach a human.

```typescript
const { answers } = await ctx.ai.decide({ decision: triageTicket, state });
const { choice: department, confidence } = answers.department;

if (confidence < 0.7) {
  await ctx.data.Ticket.update(ticket.id, { status: 'needs_human_review' });
  await ctx.events.emit('ticket.reviewRequested', { ticketId: ticket.id, department, confidence });
  return;
}

await route(department);
```

Pick thresholds from your own data, not from a default. Log `confidence` alongside the outcome from day one, then set the threshold where the error rate crosses what the downstream action can tolerate. Auto-approving a refund and auto-tagging a ticket do not deserve the same bar.

Thresholds are tuned against a **specific model version**. An alias like `jev-latest` moves when a new release ships, and the calibration can move with it. Once a threshold matters, pin the versioned id in the contract's `model` and upgrade deliberately. The result's `model` field always reports the version that actually answered, so log it.

---

## Ask many questions at once

Every question in one `decide()` call is evaluated against the same state in a single request. The state is ingested once, so asking fifteen questions together costs roughly what asking one costs — not fifteen times as much.

The practical consequence: **ask speculatively**. Include the questions you only *might* need and let your code ignore the answers it does not use. That is cheaper and faster than a second round trip, and it keeps the decision logic in one place.

```typescript
const { answers } = await ctx.ai.decide({
  state: document,
  questions: {
    // Always used.
    category: choice('What kind of document is this?', { invoice: null, contract: null, resume: null }),
    // Only read when category === 'invoice'.
    hasLineItems: noul('Does the document itemize charges?'),
    isPastDue: noul('Does the document indicate an overdue balance?'),
    // Only read when category === 'contract'.
    hasAutoRenewal: noul('Does the document contain an auto-renewal clause?'),
  },
});
```

The budget is shared, though. A provider declares a token ceiling for the state plus all questions combined, and the adapter rejects an over-budget request locally rather than letting the provider reject it. For Jev that ceiling is 64k tokens, with a tighter 32k for the state plus the single longest question — see [the TypeSafe guide](./typesafe.md#limits-and-budgets).

---

## Environment variables

| Variable | Purpose |
|---|---|
| `AI_DECISION_PROVIDER` | Which decision provider serves `ctx.ai.decide()` (currently `typesafe`). Enables the decision slot. |
| `AI_DECISION_MODEL` | Default decision model. Falls back to `AI_TYPESAFE_MODEL`. |
| `DECISION_{NAME}_PROVIDER` | Per-decision provider override. Dots in the name become underscores, uppercased. |
| `DECISION_{NAME}_MODEL` | Per-decision model override. |
| `AI_TYPESAFE_API_KEY` | TypeSafe credentials. `TYPESAFE_API_KEY` is also accepted, since the SDK reads it natively. |
| `AI_TYPESAFE_MODEL` | Default TypeSafe model for both `decide()` and native `classify()`. |
| `AI_TYPESAFE_BASE_URL` | API root override. |
| `AI_TYPESAFE_REQUEST_TIMEOUT` | Timeout per attempt, in milliseconds. |
| `AI_TYPESAFE_DAILY_COST_LIMIT` | Daily USD cap fed into the cost tracker. |

So `support.triageTicket` is overridden by `DECISION_SUPPORT_TRIAGETICKET_MODEL`.

An app whose only AI use is decisions can set `AI_DECISION_PROVIDER` with no `AI_DEFAULT_PROVIDER`; the decision provider becomes the default so the service still boots. Anything that then reaches for `generate()` gets a clear "does not support" error from the adapter rather than a confusing boot failure.

---

## Cost, budgets, and the ledger

`decide()` records to the same ledger as every other AI call, under operation `decide`:

```typescript
{
  operation: 'decide',
  provider: 'typesafe',
  model: 'jev-1.13.0',      // the version that answered, not the alias sent
  promptName: 'support.triageTicket',  // the decision name, when a contract was used
  usage: { inputTokens: 296, outputTokens: 20, totalTokens: 316 },
  cost: 0.0000124,
  status: 'success',
  latencyMs: 180,
}
```

Three details worth knowing:

- **Budget is pre-checked** from the serialized request before the call, the same way generation is. A `decide()` that would blow the daily cap throws `AIBudgetExceededError` without spending anything.
- **Adapter-supplied cost wins.** When an adapter returns `cost`, the service records that instead of computing from core's catalog. `@plumbus/ai-typesafe` owns the Jev rates, on the same principle as `@plumbus/ai-bedrock`.
- **A failed call still records a row** with `status: 'failed'` and `cost: null`. Provider-side spend on a failure is real; a decision that errors after the model ran should still be visible.

Jev is billed on **input tokens only** — output tokens are free — so a `decide()` row typically shows a nonzero `inputTokens` and a cost that barely moves regardless of how many questions you asked. That is the fan-out economics showing up in the ledger.

Per-call billing metadata works as it does elsewhere:

```typescript
await ctx.ai.decide({
  decision: triageTicket,
  state,
  costContext: {
    projectId: ticket.projectId,
    serviceArea: 'support',
    operationName: 'triageTicket',
    relatedEntityType: 'ticket',
    relatedEntityId: ticket.id,
  },
});
```

---

## Explainability and audit

With an explainability tracker configured, each `decide()` records an `ai-invocation` entry holding the decision name, the provider, the **versioned** model, the redacted input, token usage, and the full `answers` object — probabilities and confidence included.

That last part is the reason to enable it. When someone asks six months later why a ticket was routed to billing, "the model said billing" is not an answer, but "`billing` at 0.88 with confidence 0.81, from `jev-1.13.0`" is. Enable it on any capability that calls `decide()`:

```typescript
defineCapability({
  // …
  effects: { data: ['Ticket'], events: [], external: [], ai: true },
  explanation: { enabled: true },
});
```

Prompt security applies to the `state`, which is the only caller-supplied content in the request — questions are developer-authored contracts. Entity fields classified as sensitive are redacted or blocked per `AI_SECURITY_MODE`, exactly as for prompts.

---

## Governance rules

Three rules ship in `aiRules` and evaluate `inventory.decisions`. Like the existing prompt rules, they are **not** part of `plumbus verify`'s built-in rule set — register them yourself, normally in a governance test:

```typescript
import { aiRules } from '@plumbus/core';
import { assertNoGovernanceSignal, emptyInventory, evaluateGovernance } from '@plumbus/core/testing';
import { triageTicket } from '../app/decisions/triage.js';

const result = evaluateGovernance(aiRules, emptyInventory({ decisions: [triageTicket] }));
assertNoGovernanceSignal(result, ['ai.decision-missing-state-schema']);
```


| Rule | Severity | Fires when |
|---|---|---|
| `ai.decision-missing-state-schema` | Warning | A decision has no `state` schema, so any shape can be passed |
| `ai.decision-noul-missing-criteria` | Info | A noul question has no `criteria`, leaving the yes/no boundary to the model |
| `ai.decision-missing-model-config` | Info | A decision pins no model, so a moving alias answers it |

`ai.missing-explanation` already covers capabilities with `effects.ai` and no explanation tracking, which includes those calling `decide()`.

---

## Native `classify`

`ctx.ai.classify()` is multi-label: it takes a label set and returns the subset that applies. By default the AI service synthesizes a prompt, asks the default provider for a JSON array, and parses it.

An adapter can do better. `AIProviderAdapter` has an optional `classify` hook and a matching `capabilities.nativeClassify` flag; when both are present, `ctx.ai.classify()` routes there and skips prompt synthesis entirely. Security scanning, budget checks, cost recording, and explainability all stay in the service, so the caller-visible behavior is unchanged either way.

`@plumbus/ai-typesafe` implements it by asking **one Noul per label in a single request** and keeping the labels above a threshold (default `0.5`). One request, an independent probability per label, and no JSON to repair.

```bash
AI_DEFAULT_PROVIDER=typesafe    # classify() always uses the DEFAULT provider
AI_TYPESAFE_API_KEY=ts-...
```

```typescript
const labels = await ctx.ai.classify({
  labels: ['billing', 'technical', 'sales', 'spam'],
  text: ticket.body,
});
// → ['billing', 'technical']
```

There is a real constraint here: **`classify()` takes no per-call provider override**, so making it Jev-backed means making TypeSafe the default provider — which also sends `generate()` there, where it throws. Apps that need both generation and Jev-backed labels should skip `classify()` and use `decide()` with one Noul per label instead. You get the probabilities rather than a pre-filtered list, and you keep your text provider as the default:

```typescript
const { answers } = await ctx.ai.decide({
  state: ticket.body,
  questions: {
    billing: noul('Is this about billing?'),
    technical: noul('Is this a technical problem?'),
    spam: noul('Is this spam?'),
  },
});

const tags = Object.entries(answers)
  .filter(([, answer]) => answer.type === 'noul' && answer.noul > 0.6)
  .map(([label]) => label);
```

---

## Testing decisions

### Capability tests — `mockAI`

`createTestContext` gives you a `ctx.ai.decide` that needs no network and no key. Stub the answers you assert on; anything you leave out gets a deliberately undecided default for its question type (noul `0.5`, the first option of a choice, the middle level of a score, each with a uniform distribution).

```typescript
import { createTestContext, expect, it, mockEvents } from '@plumbus/core/testing';
import { triageTicket } from '../app/capabilities/triageTicket.js';

it('escalates an urgent, angry ticket', async () => {
  const events = mockEvents();
  const ctx = createTestContext({
    events,
    data: { Ticket: [{ id: 'ticket-1', subject: 'Payouts failing', body: 'Third day now.' }] },
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
  });

  const result = await triageTicket.handler(ctx, { ticketId: 'ticket-1' });

  expect(result.escalated).toBe(true);
  expect(events.emitted).toContainEqual({
    eventName: 'ticket.escalated',
    payload: expect.objectContaining({ ticketId: 'ticket-1' }),
  });
});
```

The low-confidence defaults are deliberate: a handler that forgets to gate on confidence fails the test rather than coasting on a fake certainty.

### Service tests — `createStubDecisionAdapter`

To exercise the whole path — cost recording, budget checks, explainability — register a stub adapter instead of mocking `ctx.ai`:

```typescript
import { createAIService } from '@plumbus/core';
import { createStubDecisionAdapter } from '@plumbus/core/testing';

const adapter = createStubDecisionAdapter({
  answers: { isUrgent: { type: 'noul', noul: 0.95 } },
  inputTokens: 300,
});

const ai = createAIService({
  providers: { mock: mockProvider },
  defaultProvider: 'mock',
  decisionProviders: { stub: adapter },
  defaultDecisionProvider: 'stub',
  costTracker: createCostTracker(),
});

await ai.decide({ state: 'x', questions: { isUrgent: noul('Urgent?') } });
expect(adapter.requests[0]?.state).toBe('x');
```

A question with no stubbed answer throws, so adding a question without an expectation fails loudly instead of quietly asserting on a placeholder.

### Never call the live API in unit tests

Decisions are cheap but not free, and their answers move between model versions. Keep live calls in a smoke test that skips when the key is absent — see [`examples/ai-typesafe-smoke`](../../examples/ai-typesafe-smoke).

---

## Writing your own decision adapter

`DecisionProviderAdapter` is small on purpose:

```typescript
import type { DecisionProviderAdapter } from '@plumbus/core';

const adapter: DecisionProviderAdapter = {
  name: 'my-provider',
  capabilities: {
    maxChoiceOptions: 64,
    scoreLevels: { min: 2, max: 7 },
    maxRequestTokens: 32_000,
  },
  async decide(request) {
    // request: { state, questions, model?, signal? }
    return {
      model: 'my-model-1.0.0',
      answers: { /* one per request.questions key */ },
      usage: { inputTokens: 100, outputTokens: 0, totalTokens: 100 },
      cost: 0.0001,  // optional; wins over core's catalog
    };
  },
};
```

Three contract points:

1. **Declare `capabilities`.** The service validates questions against them before calling you, so a tighter limit than the shared default is enforced for free. Omitting `capabilities` means "only the shared limits apply".
2. **Return the versioned model id** in `model`, not the alias you were sent. Callers log it to know which version produced a result.
3. **`listModels()` must not throw.** Return `[]` and warn on failure, the same as `AIProviderAdapter.listModels`, so a discovery call cannot take down a health check.

Register it through `decisionProviders`. Env-driven construction (`createDecisionAdapter`) only knows the first-party names, so custom adapters are wired programmatically.

---

## Gotchas (read this)

1. **`decide()` needs a provider, not a guard.** It is a required method on `AIService`, so call it directly. Without a registered decision provider it throws with the env var and install command in the message. Add-ons that must tolerate older core versions should check `ctx.ai.features?.typedDecisions`, not the method's presence.
2. **`decision` and `questions` are mutually exclusive.** A contract already owns its questions; passing both throws rather than silently merging.
3. **Question ids are not sent to the model.** Renaming `isUrgent` to `urgent` changes nothing about inference — it only changes your code.
4. **Aliases move.** `jev-latest` can resolve to a new version without any change on your side, and confidence calibration can shift with it. Pin a version wherever a threshold matters.
5. **`confidence` is not on Noul answers.** A single probability already *is* the uncertainty; gate on distance from `0.5`, or from whatever threshold you picked.
6. **A Score can land between levels.** `1.05` on a three-level rubric is not "level 1" — it is just past it. Compare against a number, not an index.
7. **Score probabilities are keyed by index as a string** (`'0'`, `'1'`, `'2'`), and `legend` maps those keys back to your descriptions.
8. **The token budget is shared across all questions.** Fan-out is nearly free in cost but not in context — a huge state plus many long questions can still exceed the ceiling.
9. **There is no temperature.** If you want different behavior, change `instructions` and `criteria`, not sampling.
10. **Ask atomic questions.** "Is this urgent and about billing?" gives one muddled probability. Two questions give two clean ones, at essentially the same cost.

---

## Checklist before production

- [ ] `AI_DECISION_PROVIDER` set, and the add-on installed (`pnpm add @plumbus/ai-typesafe`)
- [ ] Reused decisions live in `app/decisions/` with a `state` schema
- [ ] Every Noul has `criteria` describing what a yes and a no mean
- [ ] Confidence thresholds chosen from your own logged data, not a default
- [ ] A versioned model id pinned wherever a threshold is tuned
- [ ] `explanation: { enabled: true }` on capabilities that call `decide()`
- [ ] Every path a low-confidence answer can take has a human-review or fallback branch
- [ ] `AI_TYPESAFE_DAILY_COST_LIMIT` (or a tracker budget) set
- [ ] A governance test registers `aiRules` over your decisions and is clean of signals you did not consciously accept
- [ ] Unit tests use `mockAI` / `createStubDecisionAdapter`; live calls only in a key-gated smoke test

---

## See also

- [TypeSafe / Jev (`@plumbus/ai-typesafe`)](./typesafe.md) — the provider guide: install, env, limits, pricing, errors
- [AI Integration](./ai-integration.md) — prompts, generation, RAG, cost ledger, security
- [Governance](../core-concepts/governance.md) — rules, overrides, policy profiles
- [Testing Guide](../testing/testing-guide.md) — `createTestContext`, capability and flow tests
