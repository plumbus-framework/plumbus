# model-pricing.ts Structure Reference

File: `packages/plumbus-core/src/ai/model-pricing.ts`

## Exported Symbols

| Symbol | Kind | Description |
|--------|------|-------------|
| `Kind` | type | `'text' \| 'embedding' \| 'moderation' \| 'image' \| 'audio'` |
| `ModelRate` | interface | `{ inputPerMTok; outputPerMTok; cachedInputPerMTok?; longContextThreshold?; kind? }` — USD per 1M tokens |
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

**Only standard-tier rates are recorded.** For models the page prices by context length, use the *short* (base) context columns — the long-context columns are a separate rate the cost calculator models for GPT-5.6 Sol via its explicit 272,000-token threshold. Other OpenAI models still use base rates.

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
- **Cached input**: published `cachedInputPerMTok`, defaulting to 0.1× input
- **Cache writes**: 1.25× base input rate (Anthropic 5-min cache)
- **Long context premium**: 2× input / 1.5× output for eligible models over 200K input

The legacy `calculateModelCost()` returns numeric zero for unknown models. `estimateModelCost()` returns `undefined`; framework ledger/budget code uses this unknown-aware path. Explicitly free rates remain zero.

## Test File

`packages/plumbus-core/src/ai/__tests__/model-pricing.test.ts`

Tests cover: unknown models, standard cost, date-suffix resolution, cached tokens, cache writes, and long context premium (above/below threshold, eligible/ineligible models).

## Source URLs

- OpenAI: `https://developers.openai.com/api/docs/pricing.md`
- Anthropic: `https://platform.claude.com/docs/en/about-claude/pricing.md`

## Page Structure (what the fetch script parses)

Both pages are markdown tables. The script walks each linearly, tracking the section and tier in scope.

**OpenAI** — bare section labels (`Flagship models`, `Specialized models`, `Tools`, …) and bare tier labels (`Standard`, `Batch`, `Flex`, `Fast mode`) precede `### … data` headings, each followed by a table. Only the standard tier is read. Kinds come from the section label, or from the row's `Category` cell in the Specialized table — never from model-name patterns. Flagship tables split pricing into `Short context input`/`Short context output` and `Long context …` columns; the short-context pair is what feeds the catalog.

**Anthropic** — one 6-column table (`Model | Base Input | 5m Cache Write | 1h Cache Write | Cache Hits | Output`). Narrower Batch and Fast-mode tables further down must not be picked up. Model names carry qualifiers the script strips: `(limited availability)`, `(retired, except on …)`, `through August 31, 2026`. Dated `starting` rows activate on their effective date; `through`/`until` rows expire after that UTC day. Future rows are reported and skipped; active dated replacements take precedence regardless of row order.

If a run reports `OpenAI models found: 0` (or an implausibly low Anthropic count), the page layout changed and the parser needs updating — **do not** treat the resulting empty diff as "pricing is current."

## Fixed rates and aliases

`gpt-5.6` resolves to the canonical Sol entry, including dated suffixes. Regular Sol rates remain $5/$30 ($0.50 cached input) in the base catalog. The bundled override returns $4/$20 ($0.40 cached input) before `2026-11-22T00:00:00.000Z`. The cutoff is a static fallback after the minimum guaranteed promotional period, not a confirmed vendor expiry. The manual tool imports `allKnownModels()` to compare against the effective catalog, eliminating a duplicate snapshot. No runtime pricing fetch or polling exists; changes to the static window require a code update.
