# ai-typesafe-smoke

Live smoke for TypeSafe's Jev decision model from this monorepo. **No fake model responses.**

Exercises both surfaces `@plumbus/ai-typesafe` provides, plus the two behaviors that are easy to regress silently:

| Check | What it proves |
|---|---|
| `decide` | `ctx.ai.decide()` returns typed noul / choice / score answers, an alias resolves to a concrete version, and cost is computed from input tokens |
| `classify` | The native `classify` hook returns only requested labels |
| `listModels` | `GET /v1/models` works with the configured key |
| `localValidation` | An over-limit score rubric is rejected **before** any network call |
| `generationRejected` | `ctx.ai.generate()` throws with a message naming the right surface — Jev produces no text |

It also asserts basic plausibility (an explicitly urgent, blocked ticket must score above `0.5` for urgency) so a misrouted request that returns well-formed nonsense still fails.

## Prerequisites

```bash
pnpm --filter @plumbus/core --filter @plumbus/ai-typesafe build
```

## Setup

```bash
cd examples/ai-typesafe-smoke
cp .env.example .env
```

Put **only in `.env`** (gitignored):

```bash
AI_TYPESAFE_API_KEY=ts-…
# optional — pin a version instead of an alias:
# AI_DECISION_MODEL=jev-1.13.0
```

`TYPESAFE_API_KEY` works too; the adapter accepts either name.

## Run

```bash
node smoke.mjs
```

**Without a key it exits 0 with a skip notice**, so `pnpm test` stays runnable for contributors without a TypeSafe account.

## What this costs

Jev is charged on input tokens only (output is free) at $0.042/MTok. The whole run sends a few hundred tokens, so a full pass costs a small fraction of a cent.

## Note on the provider slots

This smoke registers TypeSafe in **both** slots on purpose — as the decision provider so `decide()` works, and as the default chat provider so `classify()` reaches the native hook. That is why `generate()` throws here, and the smoke asserts it does.

A real app that also generates text keeps OpenAI / Anthropic / Bedrock as `AI_DEFAULT_PROVIDER` and sets only `AI_DECISION_PROVIDER=typesafe`. See [`docs/ai/typesafe.md`](../../docs/ai/typesafe.md).

## Docs

- [`docs/ai/decisions.md`](../../docs/ai/decisions.md) — the `ctx.ai.decide` primitive
- [`docs/ai/typesafe.md`](../../docs/ai/typesafe.md) — this package in depth
- [`packages/ai-typesafe/README.md`](../../packages/ai-typesafe/README.md)
