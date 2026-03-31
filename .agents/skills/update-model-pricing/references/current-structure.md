# model-pricing.ts Structure Reference

File: `packages/plumbus-core/src/ai/model-pricing.ts`

## Exported Symbols

| Symbol | Kind | Description |
|--------|------|-------------|
| `ModelRate` | interface | `{ inputPerMTok: number; outputPerMTok: number }` — USD per 1M tokens |
| `calculateModelCost()` | function | Computes USD cost for a single AI request |

## Internal Constants

### `MODEL_PRICING`

`Readonly<Record<string, ModelRate>>` with section comments:

```
// ── OpenAI: Flagship ──
// ── OpenAI: Reasoning ──
// ── OpenAI: Legacy ──
// ── Anthropic: Claude ──
```

Add new entries under the matching section comment. Use the model's API identifier as the key (e.g. `'gpt-5.4'`, `'claude-opus-4-6'`).

### `LONG_CONTEXT_PREMIUM_MODELS`

`Set<string>` of model IDs that incur 2× input / 1.5× output when total input exceeds 200K tokens.

Currently: `claude-sonnet-4`, `claude-sonnet-4-5`.

Per Anthropic docs, Opus 4.6, Sonnet 4.6, and newer do **not** have this premium (they include full 1M context at standard pricing).

### `findModelRate(model)`

Looks up `MODEL_PRICING[model]`; on miss, strips a trailing 8-digit date suffix (`-20250514`) and retries. Returns `null` for unknown models.

### `hasLongContextPremium(model)`

Checks `LONG_CONTEXT_PREMIUM_MODELS` with the same date-stripping logic.

### `calculateModelCost(inputTokens, outputTokens, model, options?)`

Applies:
- **Cached input**: 0.1× base input rate
- **Cache writes**: 1.25× base input rate (Anthropic 5-min cache)
- **Long context premium**: 2× input / 1.5× output for eligible models over 200K input

Returns `0` for unknown models.

## Test File

`packages/plumbus-core/src/ai/__tests__/model-pricing.test.ts`

Tests cover: unknown models, standard cost, date-suffix resolution, cached tokens, cache writes, and long context premium (above/below threshold, eligible/ineligible models).

## Source URLs

- OpenAI: `https://developers.openai.com/api/docs/pricing.md`
- Anthropic: `https://platform.claude.com/docs/en/about-claude/pricing.md`
