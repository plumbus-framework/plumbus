---
name: update-model-pricing
description: 'Update hardcoded AI model pricing in the framework. Use when: model pricing is stale, new models are released, token costs need updating, syncing OpenAI or Anthropic pricing, adding missing model rates, verifying cost accuracy.'
argument-hint: 'Optionally specify provider (openai, anthropic) or model name to focus on'
---

# Update AI Model Pricing

Fetch the latest per-token pricing from OpenAI and Anthropic, compare against the hardcoded `MODEL_PRICING` table, and apply updates.

## When to Use

- Model pricing data is stale or out of date
- A new model has been released and needs pricing added
- You need to verify that hardcoded prices match official rates
- The "Last updated" date in `model-pricing.ts` is old

## Pricing Sources

- **OpenAI**: https://developers.openai.com/api/docs/pricing.md
- **Anthropic**: https://platform.claude.com/docs/en/about-claude/pricing.md

## Procedure

### Step 1: Fetch latest pricing

Run the fetch script from the repo root:

```bash
npx tsx .agents/skills/update-model-pricing/scripts/fetch-pricing.ts
```

The script outputs JSON to stdout with this shape:

```json
{
  "fetchedAt": "2026-03-29T...",
  "openai": [{ "model": "gpt-5.4", "inputPerMTok": 2.5, "outputPerMTok": 15 }, ...],
  "anthropic": [{ "model": "claude-opus-4-6", "inputPerMTok": 5, "outputPerMTok": 25 }, ...],
  "diff": {
    "added": [...],
    "changed": [...],
    "removed": [...]
  }
}
```

### Step 2: Sanity-check the parse, then review the diff

**First check the model counts on stderr.** Both providers should report dozens of models. `OpenAI models found: 0` — or a count far below the catalog size — means the pricing page layout changed and the parser is broken, not that pricing is current. An empty diff from a failed parse looks exactly like an empty diff from an up-to-date catalog. Fix the parser before trusting the result.

Then review the diff:

- **added**: Models on the pricing page not in `MODEL_PRICING` → add them
- **changed**: Models with different prices → update the values
- **removed**: Models in `MODEL_PRICING` not on the pricing page → flag for review (do NOT auto-delete; they may be intentional aliases)
- **(upcoming)** stderr lines: a scheduled future price. Leave the catalog on today's rate and note the change date in the file header.

### Step 3: Update model-pricing.ts

File: `packages/plumbus-core/src/ai/model-pricing.ts`

1. Add new model entries to the `MODEL_PRICING` constant under the correct section comment (`OpenAI: Flagship`, `OpenAI: Reasoning`, `OpenAI: Specialized`, `OpenAI: Embeddings`, `OpenAI: Moderation`, `OpenAI: Legacy`, `Anthropic: Claude`)
2. Update any changed pricing values
3. Check if `LONG_CONTEXT_PREMIUM_MODELS` needs updating (currently Claude Sonnet 4 and 4.5; Sonnet 4.6 and Opus models do NOT have long context premium)
4. Update the `// Last updated:` comment at the top of the file to today's date

Keep the `CURRENT_PRICING` snapshot inside `scripts/fetch-pricing.ts` in sync with the same edits — it is what the next run diffs against. Re-running the script should then report 0 added and 0 changed.

See [current-structure.md](./references/current-structure.md) for the file's detailed layout and the pricing-page structure the script depends on.

### Step 4: Update tests

File: `packages/plumbus-core/src/ai/__tests__/model-pricing.test.ts`

- If any **existing test assertions** use pricing values that changed, update them
- Add a test for at least one newly added model to verify it returns non-zero cost
- Ensure long-context premium tests still pass if the eligible model set changed

### Step 5: Update documentation

File: `docs/ai/ai-integration.md`

- If the supported model list changed significantly, update the cost tracking section

### Step 6: Validate

Run all four checks from the repo root:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
```

All must pass with zero errors before considering the update complete.

## Important Notes

- Only **standard** tier pricing is tracked (not batch, flex, priority, or fast-mode)
- Cache pricing multipliers (0.1× for reads, 1.25× for 5-min writes) are hardcoded in `calculateModelCost()` and rarely change
- The `findModelRate()` function strips trailing 8-digit date suffixes (e.g. `-20250514`), so dated variants don't need separate entries
- Unknown models return cost `$0` — this is intentional for Ollama/custom endpoints
