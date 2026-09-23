# @plumbus/ai-decision-laya — agent instructions

| File | When to read |
| --- | --- |
| [framework.md](framework.md) | Installation, public exports, adapter boundary, usage rules |
| [testing.md](testing.md) | Offline validation and live environment setup |

**Classification, categorization, provider/model selection, TypeSafe/Jev or Laya:**
read `node_modules/@plumbus/core/instructions/ai-classification.md` first (core
**0.7.4+**), then [framework.md](framework.md) for this package.

Core 0.7.3+ provides `ctx.ai.decide()`; core 0.7.4+ also routes `ctx.ai.classify()`
to explicitly registered decision adapters. Keep app business logic in Plumbus
primitives and `ctx.*`. Never route predictions around capability access checks
or confirmation policy. Provider registration is explicit in `app/server.ts`.

[Package README](../README.md) · [Monorepo guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
