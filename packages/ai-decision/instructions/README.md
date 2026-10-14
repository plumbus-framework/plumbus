# @plumbus/ai-decision — agent instructions

| File | When to read |
| --- | --- |
| [framework.md](framework.md) | Installation, public exports, adapter boundary, usage rules |
| [testing.md](testing.md) | Offline validation and live environment setup |

**Classification, categorization, provider/model selection, TypeSafe/Jev, Laya or OpenAI Decisions:**
read `node_modules/@plumbus/core/instructions/ai-classification.md` first (core
**0.7.4+**; beta line **0.8.0-beta.6+**; every 0.8 stable and 0.9 beta release includes
it), then [framework.md](framework.md) for this package.

Provider packages, each with its own `instructions/README.md`:
`@plumbus/ai-decision-typesafe` (TypeSafe/Jev), `@plumbus/ai-decision-laya` (self-hosted
Laya), and `@plumbus/ai-decision-openai` (OpenAI Decisions API; use this beta family or stable core 0.7.9+).

Core 0.7.3+ provides `ctx.ai.decide()`; core 0.7.4+ also routes `ctx.ai.classify()`
to explicitly registered decision adapters (both on the beta line from 0.8.0-beta.6,
and in every 0.8 stable and 0.9 beta release). Keep app business logic in Plumbus
primitives and `ctx.*`. Never route predictions around capability access checks
or confirmation policy. Provider registration is explicit in `app/server.ts`.

[Package README](../README.md) · [Monorepo guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
