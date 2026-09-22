# Writing decisions — prescriptive recipes

**Exact path in a consumer app:** `node_modules/@plumbus/ai-typesafe/instructions/decisions.md`

Read [framework.md](./framework.md) first for install and wiring. This file is about **writing good questions and thresholds**. Conceptual reference: `docs/ai/decisions.md` in the monorepo.

---

## Pick the right question type

| The answer is | Type | Returns |
|---|---|---|
| Yes or no | `noul` | Probability the answer is yes, `0`–`1` |
| Exactly one of a known set | `choice` | The top option, every option's probability, `confidence` |
| A level on an ordered rubric | `score` | A probability-weighted value that can land between levels, `legend`, `probabilities`, `confidence` |
| Open-ended text | **not a decision** | Use `definePrompt` + `ctx.ai.generate` on a text provider |

Do not model a yes/no as a two-option Choice. A Noul gives you one number to threshold; a Choice makes you read a distribution to recover the same thing.

Do not model an ordered rubric as a Choice. A Score's value carries *how far along* the rubric the state sits; a Choice throws that ordering away.

---

## Always give Nouls criteria

```typescript
// Do this
noul('Does this message convey urgency?', {
  true: 'Explicitly time-sensitive: a deadline, an outage, or blocked work',
  false: 'No urgency expressed, or a general question',
});

// Not this
noul('Is this urgent?');
```

Without `criteria` the yes/no boundary is the model's guess, and the probability you get back does not mean what you assumed. Core's governance rule `ai.decision-noul-missing-criteria` flags this.

The same applies to Choice rubrics. Describe what each option covers; use `null` only for options that are genuinely self-explanatory.

```typescript
choice('Which team should handle this ticket?', {
  billing: 'Payments, invoicing, refunds, subscription changes',
  technical: 'Bugs, outages, API errors, integration failures',
  sales: 'Pricing questions, upgrades, new accounts',
});
```

---

## Ask atomic questions

```typescript
// Do this — two clean probabilities
{
  isUrgent: noul('Does this convey urgency?', { true: '…', false: '…' }),
  isBilling: noul('Is this about billing?', { true: '…', false: '…' }),
}

// Not this — one muddled probability
{
  urgentBilling: noul('Is this an urgent billing issue?'),
}
```

A compound question forces the model to average two judgments into one number, and you cannot recover which half drove it. Two questions in the same call cost essentially the same, because the state is ingested and billed once.

Decompose broad judgments and combine them in **your** code, where the weights are reviewable:

```typescript
const priority =
  answers.isUrgent.noul * 0.5 +
  answers.frustration.score / 2 * 0.3 +
  (answers.isEnterprise.noul > 0.8 ? 0.2 : 0);
```

---

## Batch speculatively

Jev reads the state once and evaluates every question against it in parallel. Fifteen questions in one call cost roughly what one costs. So include the questions you only *might* need:

```typescript
const { answers } = await ctx.ai.decide({
  state: document,
  questions: {
    category: choice('What kind of document is this?', {
      invoice: null, contract: null, resume: null,
    }),
    // Read only when category === 'invoice'
    hasLineItems: noul('Does the document itemize charges?', { true: '…', false: '…' }),
    isPastDue: noul('Does it indicate an overdue balance?', { true: '…', false: '…' }),
    // Read only when category === 'contract'
    hasAutoRenewal: noul('Does it contain an auto-renewal clause?', { true: '…', false: '…' }),
  },
});
```

One request beats a `category` call followed by a follow-up call, on both cost and latency.

**The budget is shared:** 64k tokens for the state plus all questions, and 32k for the state plus the single longest question. The adapter rejects an over-budget request locally with the estimated token count. Do not try to fan out past the ceiling — split by state, not by question.

---

## Put reusable decisions in a contract

Inline questions are fine for a one-off. Anything reused, or whose thresholds you tune, belongs in `app/decisions/`:

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
  model: { name: 'jev-1.13.0' },
});
```

```typescript
const { answers } = await ctx.ai.decide({
  decision: triageTicket,
  state: { subject: ticket.subject, body: ticket.body },
});
```

What the contract buys: the `state` is parsed before any network call; structural limits are checked at import rather than in production; `DECISION_SUPPORT_TRIAGETICKET_MODEL` can re-point it without a deploy; governance can see it; and the explainability record carries its name.

Files in `app/decisions/` are auto-discovered by `plumbus dev` / `start` / `worker`, so you can also pass the name: `ctx.ai.decide({ decision: 'support.triageTicket', state })`.

**Always give a contract a `state` schema.** `ai.decision-missing-state-schema` is a Warning-level governance rule, and for good reason: without it a caller can pass any shape and the model will answer confidently about the wrong thing.

---

## Gate on confidence

Choice and Score answers carry `confidence` derived from the distribution. It is a **different axis** from the answer:

- The **answer** tells you *what* the model concluded.
- **Confidence** tells you *whether to act on it*.

An 80/20 split and a 45/42/13 split can both put `billing` on top. Only the second should reach a human.

```typescript
const { choice: department, confidence } = answers.department;

if (confidence < 0.7) {
  await ctx.data.Ticket.update(ticket.id, { status: 'needs_human_review' });
  await ctx.events.emit('ticket.reviewRequested', { ticketId: ticket.id, department, confidence });
  return;
}

await route(department);
```

Rules:

1. **Never hardcode a threshold from a doc example.** Log `confidence` and the outcome from day one, then set the threshold where the error rate crosses what the downstream action tolerates.
2. **Different actions deserve different bars.** Auto-tagging a ticket and auto-approving a refund are not the same risk.
3. **Every low-confidence path needs a destination** — human review, a safe default, or a more expensive model. A decision with no fallback branch is a decision you have not finished.
4. **Noul answers have no `confidence`** — a single probability already *is* the uncertainty. Gate on distance from your threshold, e.g. treat `0.4 < noul < 0.6` as undecided.

---

## Pin the model where thresholds matter

```typescript
model: { name: 'jev-1.13.0' }   // not 'jev-latest'
```

An alias moves when a new version ships, and calibration can move with it — so a threshold you tuned last month can quietly change meaning. Pin the version in the contract and upgrade deliberately.

The response's `model` field always reports the version that actually answered, and the AI service records it in the cost ledger and the explainability entry. Log it even when you use an alias.

---

## Multi-label tagging

Two options, and the right one depends on whether your app also generates text.

**App generates text (the usual case)** — use `decide()` with one Noul per label. You keep your text provider as the default and get the raw probabilities:

```typescript
const { answers } = await ctx.ai.decide({
  state: ticket.body,
  questions: {
    billing: noul('Is this about billing?', { true: '…', false: '…' }),
    technical: noul('Is this a technical problem?', { true: '…', false: '…' }),
    spam: noul('Is this spam or automated?', { true: '…', false: '…' }),
  },
});

const tags = Object.entries(answers)
  .filter(([, a]) => a.type === 'noul' && a.noul > 0.6)
  .map(([label]) => label);
```

**App is decisions-only** — set `AI_DEFAULT_PROVIDER=typesafe` and use `ctx.ai.classify()`, which this package serves natively with the same one-Noul-per-label shape and a `labelThreshold` (default `0.5`).

Do not set `AI_DEFAULT_PROVIDER=typesafe` just to get `classify()` in an app that also generates text — `generate()` will throw.

---

## Structured instructions

`instructions` accepts a string, an object, or an array. Use structure when a question must reference data: put the question in one field, the data in the others, and refer to data fields by name in backticks.

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

This keeps the question readable and keeps its comparison data out of the `state`, which matters when the state is a large document you want judged as a whole.

---

## Enable explanation tracking

```typescript
defineCapability({
  name: 'triageTicket',
  domain: 'support',
  kind: 'action',
  effects: { data: ['Ticket'], events: ['ticket.escalated'], external: [], ai: true },
  explanation: { enabled: true },
  // …
});
```

The explainability record holds the full `answers` object — probabilities and confidence — plus the versioned model and the decision name. That is what lets you answer "why was this routed to billing" six months later, and what lets you re-tune a threshold against real traffic. `ai.missing-explanation` is a Warning-level governance rule for any capability with `effects.ai`.

---

## Anti-patterns

| Don't | Do |
|---|---|
| Prompt a chat model for JSON when the output space is closed | `ctx.ai.decide()` |
| `noul('Is this urgent?')` with no criteria | Add `criteria: { true, false }` |
| One compound question | Several atomic ones in the same call |
| A second `decide()` call for a follow-up question | Add the question to the first call |
| Act on `answers.x.choice` without reading `confidence` | Gate, with a human-review branch |
| `jev-latest` under a tuned threshold | Pin `jev-1.13.0` |
| Inline questions duplicated across three capabilities | One `defineDecision()` in `app/decisions/` |
| A contract with no `state` schema | Add the Zod schema |
| `AI_DEFAULT_PROVIDER=typesafe` in a text-generating app | `AI_DECISION_PROVIDER=typesafe` |
| Importing `@typesafe-ai/sdk` in app code | Register the adapter; use `ctx.ai.decide()` |
| Reimplementing retries or cost tracking | The SDK retries; core tracks cost |
| Live API calls in unit tests | `mockAI` / `createStubDecisionAdapter` — see [testing.md](./testing.md) |
