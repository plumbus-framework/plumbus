# Typed Decisions

Plumbus has two AI surfaces, and picking the wrong one is the most common AI mistake in a Plumbus app.

| The output is | Use | Primitive |
|---|---|---|
| **Closed** — yes/no, one of a known set, a level on a rubric | `ctx.ai.decide()` | `defineDecision()` |
| **Open** — prose, code, a summary, a draft | `ctx.ai.generate()` | `definePrompt()` |

**Do not prompt a chat model for JSON when the output space is closed.** That is the pattern `decide()` exists to replace: you prompt for a schema, validate it, retry on drift, and still end up with no idea how close the call was. A decision returns typed answers with calibrated probabilities — nothing to parse, nothing to repair, and the model's own uncertainty is part of the answer.

Full reference: `docs/ai/decisions.md` in the monorepo.

## Requires a decision provider

Core ships the primitive; the provider is an optional add-on. Without one, `ctx.ai.decide()` throws with the env var and install command in the message.

```bash
pnpm add @plumbus/ai-typesafe
```

```bash
AI_DEFAULT_PROVIDER=openai      # text generation stays on a text provider
AI_OPENAI_API_KEY=sk-...
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe   # enables ctx.ai.decide()
AI_DECISION_MODEL=jev-latest
```

Decision providers are a **separate slot** from chat providers (`decisionProviders` / `AI_DECISION_PROVIDER`, not `providers` / `AI_DEFAULT_PROVIDER`). Running OpenAI for `generate()` and TypeSafe for `decide()` at the same time is the normal configuration — do not replace the text provider to add decisions.

## The three question types

```ts
import { choice, noul, score } from "@plumbus/core";

// Yes/no → probability the answer is yes
noul("Does this convey urgency?", {
  true: "Explicitly time-sensitive",
  false: "No urgency expressed",
});

// One of a set → top option + full distribution + confidence
choice("Which team should handle this?", {
  billing: "Payments, invoicing, refunds",
  technical: "Bugs, outages, integrations",
});

// Ordered rubric → probability-weighted value + legend + confidence
score("How frustrated is the customer?", ["Calm", "Frustrated", "Very angry"]);
```

Rules:

- **Always give a Noul `criteria`.** Without a yes/no rubric the boundary is the model's guess and the probability does not mean what you assumed. Governance rule: `ai.decision-noul-missing-criteria`.
- **Do not model a yes/no as a two-option Choice** — a Noul gives you one number to threshold.
- **Do not model an ordered rubric as a Choice** — a Score's value carries how far along the rubric the state sits.
- Limits: at most **255** Choice options, **2–10** Score levels. Both are validated at `defineDecision()` time, so a bad rubric fails at import.

## Calling `ctx.ai.decide`

```ts
const { answers, usage, cost } = await ctx.ai.decide({
  state: { subject: ticket.subject, body: ticket.body },
  questions: {
    isUrgent: noul("Does this convey urgency?", { true: "…", false: "…" }),
    department: choice("Which team should handle this?", {
      billing: "Payments, invoicing, refunds",
      technical: "Bugs, outages, integrations",
    }),
  },
});

// answers.isUrgent.noul        → number
// answers.department.choice    → "billing" | "technical"
// answers.department.confidence → number
```

`decide` is a required method on `AIService` — call it directly. Without a registered decision provider it throws with the env var and install command in the message. Use `ctx.ai.features?.typedDecisions` only when writing an add-on that must tolerate older core versions.

Question ids are yours and are **not** sent to the model — name them for your code's benefit.

## Contracts go in `app/decisions/`

Anything reused, or whose thresholds you tune, belongs in a contract next to `app/prompts/`:

```ts
// app/decisions/triage.ts
import { choice, defineDecision, noul } from "@plumbus/core";
import { z } from "zod";

export const triageTicket = defineDecision({
  name: "support.triageTicket",
  domain: "support",
  state: z.object({ subject: z.string(), body: z.string() }),
  questions: {
    isUrgent: noul("Does this convey urgency?", { true: "…", false: "…" }),
    department: choice("Which team should handle this?", {
      billing: "Payments, invoicing, refunds",
      technical: "Bugs, outages, integrations",
    }),
  },
  model: { name: "jev-1.13.0" },
});
```

```ts
await ctx.ai.decide({ decision: triageTicket, state });
// or, once discovered:
await ctx.ai.decide({ decision: "support.triageTicket", state });
```

Files in `app/decisions/` are auto-discovered by `plumbus dev` / `start` / `worker` and registered in a `DecisionRegistry`.

- **Always give a contract a `state` schema.** It is parsed before any network call, so a contract drift fails locally instead of producing a confident answer about the wrong shape. Governance rule: `ai.decision-missing-state-schema`.
- `decision` and `questions` are **mutually exclusive** — passing both throws.
- There is **no `temperature` or `maxTokens`** on a `DecisionModelConfig`. A decision returns a calibrated distribution, not sampled text. Shape answers through `instructions` and `criteria`.

Resolution order: call argument → `DECISION_{NAME}_*` env → contract `model` → `AI_DECISION_MODEL` / `AI_DECISION_PROVIDER`.

## Gate on confidence

Choice and Score answers carry `confidence`. It is a different axis from the answer: the answer says *what*, confidence says *whether to act*.

```ts
const { choice: department, confidence } = answers.department;

if (confidence < 0.7) {
  await ctx.data.tickets.update(ticket.id, { status: "needs_human_review" });
  return;
}
await route(department);
```

- **Never hardcode a threshold from an example.** Log `confidence` and the outcome, then set the threshold where the error rate crosses what the action tolerates.
- **Every low-confidence path needs a destination** — human review, a safe default, or a more expensive model.
- **Different actions deserve different bars.** Auto-tagging and auto-refunding are not the same risk.
- Noul answers have **no** `confidence` — a single probability already is the uncertainty. Treat a band around your threshold (e.g. `0.4`–`0.6`) as undecided.
- **Pin a versioned model** wherever a threshold is tuned. An alias moves when a release ships and calibration can move with it. Governance rule: `ai.decision-missing-model-config`.

## Batch questions into one call

Every question in one `decide()` is evaluated against the same state in a single request, and the state is ingested and billed once. Fifteen questions cost roughly what one costs.

So **ask speculatively**: include the questions you only might need and let code ignore the rest. That beats a second round trip on both cost and latency. Ask **atomic** questions — "Is this urgent and about billing?" yields one muddled probability where two questions yield two clean ones.

The token budget is shared across the state and all questions (64k for TypeSafe Jev, with 32k for the state plus the longest question). The adapter rejects an over-budget request locally.

## Cost, security, explainability

`decide()` goes through the same machinery as `generate()`:

- **Budget** is pre-checked before the call; over-cap throws `AIBudgetExceededError` without spending.
- **Ledger** rows land under operation `decide`, carrying the versioned model that answered and the decision name in `promptName`.
- **Prompt security** scans the `state` (the only caller-supplied content — questions are developer-authored contracts).
- **Explainability** records the full `answers` object, probabilities and confidence included. Set `explanation: { enabled: true }` on any capability calling `decide()` — that record is what answers "why was this routed here" later.

## Native `classify`

`ctx.ai.classify()` is multi-label. An `AIProviderAdapter` that declares `capabilities.nativeClassify` and implements the optional `classify` hook serves it natively, skipping prompt synthesis and JSON parsing; security, budget, cost, and explainability stay in the AI service either way.

`ctx.ai.classify()` always uses the **default** provider and takes no per-call override. So in an app that also generates text, do **not** switch the default to a decision provider just to get native classify — use `decide()` with one Noul per label instead:

```ts
const { answers } = await ctx.ai.decide({
  state: ticket.body,
  questions: {
    billing: noul("Is this about billing?", { true: "…", false: "…" }),
    technical: noul("Is this a technical problem?", { true: "…", false: "…" }),
  },
});

const tags = Object.entries(answers)
  .filter(([, a]) => a.type === "noul" && a.noul > 0.6)
  .map(([label]) => label);
```

## Testing

Never call a live decision API from a unit test.

```ts
import { createTestContext } from "@plumbus/core/testing";

const ctx = createTestContext({
  ai: {
    decide: {
      department: {
        type: "choice",
        choice: "billing",
        probabilities: { billing: 0.9, technical: 0.1 },
        confidence: 0.85,
      },
    },
  },
});
```

Answers you omit get a deliberately undecided default (noul `0.5`, first choice option, middle score level, uniform distribution, low confidence) so a handler that forgets to gate on confidence fails the test.

For the full service path — cost rows, budgets, explainability — register `createStubDecisionAdapter` from `@plumbus/core/testing` instead of mocking `ctx.ai`. A question with no stubbed answer throws.

**Always test the low-confidence branch.** The top answer is present and plausible in that case; only `confidence` distinguishes it.

## Anti-patterns

| Don't | Do |
|---|---|
| `definePrompt` with a JSON output schema for a closed output space | `defineDecision` + `ctx.ai.decide()` |
| `noul("Is this urgent?")` with no criteria | Add `criteria: { true, false }` |
| One compound question | Several atomic ones in the same call |
| A second `decide()` call for a follow-up | Add the question to the first call |
| Acting on `answers.x.choice` without reading `confidence` | Gate, with a human-review branch |
| A moving alias under a tuned threshold | Pin the versioned id in the contract |
| A contract with no `state` schema | Add the Zod schema |
| `AI_DEFAULT_PROVIDER=typesafe` in a text-generating app | `AI_DECISION_PROVIDER=typesafe` |
| Importing a provider SDK in app code | Register the adapter; use `ctx.ai.decide()` |
| Live API calls in unit tests | `mockAI` / `createStubDecisionAdapter` |
