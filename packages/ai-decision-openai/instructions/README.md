# @plumbus/ai-decision-openai — agent instructions

| File | When to read |
| --- | --- |
| [framework.md](framework.md) | Installation, public exports, question mapping, adapter boundary, usage rules |
| [testing.md](testing.md) | Offline validation and live environment setup |

**Classification, categorization, provider/model selection, OpenAI Decisions:**
read `node_modules/@plumbus/core/instructions/ai-classification.md` first (core
**0.7.4+**), then [framework.md](framework.md) for this package.

OpenAI's Decisions API is in public beta; this adapter follows OpenAI's documentation as
of 2026-10-08.

Core 0.7.3+ provides `ctx.ai.decide()`; core 0.7.4+ also routes `ctx.ai.classify()`
to explicitly registered decision adapters. Keep app business logic in Plumbus
primitives and `ctx.*`. Never route predictions around capability access checks
or confirmation policy. Provider registration is explicit in `app/server.ts`,
under `decisions.providers` with a key that differs from any text provider (for
example `openai-decisions`).

[Package README](../README.md) · [Monorepo guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
