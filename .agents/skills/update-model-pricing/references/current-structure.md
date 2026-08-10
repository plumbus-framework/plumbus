# model-pricing.ts Structure Reference

File: `packages/plumbus-core/src/ai/model-pricing.ts`

## Exported Symbols

| Symbol | Kind | Description |
|--------|------|-------------|
| `Kind` | type | `'text' \| 'embedding' \| 'moderation' \| 'image' \| 'audio'` |
| `ModelRate` | interface | `{ inputPerMTok: number; outputPerMTok: number; kind?: Kind }` — USD per 1M tokens |
| `findModelRate()` | function | Looks up a model's rate, with date-suffix fallback |
| `allKnownModels()` | function | All `[id, rate]` pairs, for `listModels()` joins |
| `calculateModelCost()` | function | Computes USD cost for a single AI request |

## Internal Constants

### `MODEL_PRICING`

`Readonly<Record<string, ModelRate>>` with section comments:

```
// ── OpenAI: Flagship ──
// ── OpenAI: Reasoning ──
// ── OpenAI: Specialized / Deep research / Computer use ──
// ── OpenAI: Specialized / ChatGPT, Codex, Cyber, Search ──
// ── OpenAI: Embeddings ──
// ── OpenAI: Moderation (free) ──
// ── OpenAI: Legacy (chat/completion) ──
// ── Anthropic: Claude ──
```

Add new entries under the matching section comment. Use the model's API identifier as the key (e.g. `'gpt-5.4'`, `'claude-opus-4-6'`). Every entry populates `kind`.

**Only standard-tier rates are recorded.** For models the page prices by context length, use the *short* (base) context columns — the long-context columns are a separate rate the cost calculator does not model for OpenAI.

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

## Page Structure (what the fetch script parses)

Both pages are markdown tables. The script walks each linearly, tracking the section and tier in scope.

**OpenAI** — bare section labels (`Flagship models`, `Specialized models`, `Tools`, …) and bare tier labels (`Standard`, `Batch`, `Flex`, `Fast mode`) precede `### … data` headings, each followed by a table. Only the standard tier is read. Kinds come from the section label, or from the row's `Category` cell in the Specialized table — never from model-name patterns. Flagship tables split pricing into `Short context input`/`Short context output` and `Long context …` columns; the short-context pair is what feeds the catalog.

**Anthropic** — one 6-column table (`Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output`). Narrower Batch and Fast-mode tables further down must not be picked up. Model names carry qualifiers the script strips: `(limited availability)`, `(retired, except on …)`, `through August 31, 2026`. A row whose qualifier reads `starting <Month> <day>` is a scheduled future price — it is reported on stderr and excluded, so today's rate is what lands in the catalog.

If a run reports `OpenAI models found: 0` (or an implausibly low Anthropic count), the page layout changed and the parser needs updating — **do not** treat the resulting empty diff as "pricing is current."
