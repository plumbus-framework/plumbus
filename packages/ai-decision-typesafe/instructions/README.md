# @plumbus/ai-decision-typesafe — agent instructions

| File | When to read |
| --- | --- |
| [framework.md](framework.md) | Installation, public exports, adapter boundary, usage rules |
| [testing.md](testing.md) | Offline validation and live environment setup |

Keep app business logic in Plumbus primitives and `ctx.*`. These packages do not
add `ctx.ai.decide()` or automatic provider discovery yet. Never route model
predictions directly around capability access checks or confirmation policy.

[Package README](../README.md) · [Monorepo guide](https://github.com/plumbus-framework/plumbus/blob/main/docs/ai/decision-providers.md)
