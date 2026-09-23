# Classification provider/model selection and agent guidance

Core **0.7.4** lets `ctx.ai.classify()` select either a generative provider or a
registered TypeSafe/Jev or Laya decision adapter. Existing calls retain their text
default and `string[]` result. `decide()` remains the richer typed-question API.

## Prepared versions

| Package | Previous workspace version | Prepared |
| --- | --- | --- |
| `@plumbus/core` | 0.7.3 | 0.7.4 |
| `@plumbus/ai-decision` | 0.2.1 | 0.2.2 |
| `@plumbus/ai-decision-typesafe` | 0.2.1 | 0.2.2 |
| `@plumbus/ai-decision-laya` | 0.2.1 | 0.2.2 |

The decision package patches ship updated consumer instructions. Core and provider
packages depend on shared contracts `~0.2.2`. Existing decision adapters on 0.2.1
remain compatible with this classification API; core 0.7.4 is the feature floor.
Canonical core peers stay `0.7.x`. Other package versions remain unchanged.
No database migration is introduced; app-owned cost ledgers must accept `decide`
and `classify`, preserve unknown costs as `null`, and persist failed calls.

## Upgrade and make the recipe discoverable

Install core and only the provider you use, then refresh your application lockfile:

```bash
pnpm add @plumbus/core@~0.7.4 @plumbus/ai-decision-typesafe@~0.2.2
# Or choose @plumbus/ai-decision-laya@~0.2.2 instead of TypeSafe.
plumbus init --patch --agent all
plumbus doctor
```

Agent wiring **v17** points Copilot, Cursor, AGENTS.md, and CLAUDE.md directly to
`node_modules/@plumbus/core/instructions/ai-classification.md` and the decision
package indexes, in both inline/reference and flat/monorepo modes. Cursor's
capability rule links the recipe too. `--patch` preserves app-owned text outside
Plumbus-managed blocks. If configuring agents manually, link that recipe or the
core `instructions/README.md`.

## Provider and model selection

Register adapters under `decisions.providers` in `app/server.ts` for API and
workers. Keep credentials and adapter construction at that server boundary.
Inside a capability/flow:

```ts
const labels = await ctx.ai.classify({
  text: input.ticketText,
  labels: ['billing', 'technical', 'refund'],
  provider: 'typesafe',
  model: 'jev-1.13.0',
  threshold: 0.5,
});
```

- `provider` is a registered key. Omitting it uses the existing default text provider.
- `model` is optional. For decision providers it overrides `decisions.defaultModel`
  and then the adapter default; for text providers it overrides the AI service
  `defaultModel` and then the adapter default.
- Laya supports `model: 'auto'` for language routing or a checkpoint configured on
  that server. Generative providers accept their own model IDs; omit `threshold`.
- Native classification batches independent label probabilities, returning labels
  at or above `threshold` (default 0.5), with zero or multiple matches allowed.
- Security, budgets, cancellation, validation, and identity use the shared decision
  path. The cost hook receives one `classify` row, not an additional `decide` row.

The [packaged recipe](../packages/plumbus-core/instructions/ai-classification.md)
contains registration, model defaults, tests, and the choice between `classify()`
and `decide()`. See [AI integration](ai/ai-integration.md#classify-categorization)
and [decision providers](ai/decision-providers.md) for reference.

## Release checks

Run lint, format checking, typechecking, and tests. Verify packed instructions and
workspace dependency rewriting; publish shared contracts before core and the two
adapters. The existing publish workflow includes all four packages. Preparing these
files does not publish packages or create Git commits, tags, or pushes.
