# @plumbus/ai-typesafe — agent instructions

**Exact path in a consumer app:** `node_modules/@plumbus/ai-typesafe/instructions/README.md`

| File | When to read |
|------|----------------|
| [framework.md](./framework.md) | Package boundary, install, env table, public exports, wiring |
| [decisions.md](./decisions.md) | **Writing questions**: noul / choice / score, contracts, confidence gating, fan-out |
| [testing.md](./testing.md) | Testing decisions offline — `mockAI`, `createStubDecisionAdapter`, stub clients |

## Reading order

1. **framework.md** — install + `AI_TYPESAFE_*` + which slot to register.
2. **decisions.md** — before writing any question or threshold.
3. **testing.md** — before writing a test that touches `ctx.ai.decide`.

## Critical rules

1. **This package does not generate text.** Jev is a decision model. Registering it as `AI_DEFAULT_PROVIDER` makes `ctx.ai.generate()`, `streamGenerate()`, `extract()`, and embeddings throw. Set **`AI_DECISION_PROVIDER=typesafe`** and leave `AI_DEFAULT_PROVIDER` on a text provider (OpenAI / Anthropic / Bedrock) unless the app has no text surface at all.
2. Install `@plumbus/ai-typesafe` explicitly — core will not bundle the TypeSafe SDK.
3. **Decision providers are a separate slot** from chat providers: `decisionProviders` / `AI_DECISION_PROVIDER`, not `providers` / `AI_DEFAULT_PROVIDER`. Running OpenAI for `generate()` and TypeSafe for `decide()` at once is the normal configuration.
4. Use `ctx.ai.decide()` whenever the output space is **closed** (yes/no, one of a set, a level on a rubric). Use `definePrompt` + `ctx.ai.generate()` only for open-ended text. Do **not** prompt a chat model for JSON when a decision fits.
5. **Always give Noul questions `criteria`** describing what a yes and a no mean. Without it the boundary is the model's guess. Core's governance rule `ai.decision-noul-missing-criteria` flags this.
6. **Gate on `confidence`, not just the answer.** Choice and Score answers carry it. Every branch a low-confidence answer can take needs a human-review or fallback path. Pick thresholds from your own logged traffic, never a default.
7. **Pin a versioned model id** (`jev-1.13.0`) in the decision contract wherever a threshold is tuned. `jev-latest` moves when a release ships and calibration can move with it.
8. **Batch questions into one call.** The state is ingested once and billed once, so fifteen questions cost roughly what one costs. Ask speculatively and let code ignore what it does not need. Budget: 64k tokens for state plus all questions.
9. **Ask atomic questions.** "Is this urgent and about billing?" gives one muddled probability; two questions give two clean ones at the same cost.
10. Business logic stays in Plumbus primitives (`defineDecision`, `defineCapability`, `ctx.*`); this package is only the TypeSafe adapter. Never import `@typesafe-ai/sdk` from app code.
11. **No temperature, no maxTokens.** A decision returns a calibrated distribution, not sampled text. Shape answers through `instructions` and `criteria`.
12. Never call the live API from unit tests. Use `mockAI` / `createStubDecisionAdapter` from `@plumbus/core/testing` — read [testing.md](./testing.md).
13. After install on an existing app, run `plumbus init --patch` (wiring version 17+) so agents see these instruction paths; `plumbus doctor` reports stale wiring.

## Quick reference

```bash
pnpm add @plumbus/ai-typesafe
```

```bash
AI_DEFAULT_PROVIDER=openai        # text stays on a text provider
AI_OPENAI_API_KEY=sk-...
AI_TYPESAFE_API_KEY=ts-...
AI_DECISION_PROVIDER=typesafe     # enables ctx.ai.decide()
AI_DECISION_MODEL=jev-latest
```

```typescript
import { choice, noul } from '@plumbus/core';

const { answers } = await ctx.ai.decide({
  state: ticket.body,
  questions: {
    isUrgent: noul('Does this convey urgency?', {
      true: 'Explicitly time-sensitive',
      false: 'No urgency expressed',
    }),
    department: choice('Which team should handle this?', {
      billing: 'Payments, invoicing, refunds',
      technical: 'Bugs, outages, integrations',
    }),
  },
});

if (answers.department.confidence < 0.7) return sendToHumanReview();
await route(answers.department.choice);
```

## Monorepo docs (bookmark)

```text
docs/ai/decisions.md     the ctx.ai.decide primitive, question types, confidence
docs/ai/typesafe.md      this package: env, limits, pricing, errors, checklist
docs/ai/ai-integration.md  the wider AI stack
```

Package README: [../README.md](../README.md)
