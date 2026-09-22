import { describe, expect, it } from 'vitest';
import {
  parseAnthropicPricing,
  parseOpenAIPricing,
} from '../../../../../.agents/skills/update-model-pricing/scripts/fetch-pricing.js';

describe('pricing refresh parsers', () => {
  it('selects standard base-context prices and preserves non-default cache rates', () => {
    const prices = parseOpenAIPricing(`Flagship models
Standard
### Standard pricing data
| Model | Short context input | Short context cached input | Short context output | Long context input | Long context output |
| --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10 | $1 | $50 | $20 | $75 |
| gpt-4o | $2.5 | $1.25 | $10 | - | - |
Batch
### Batch pricing data
| Model | Input | Output |
| --- | --- | --- |
| gpt-6-astra | $5 | $25 |
`);
    expect(prices).toEqual([
      { model: 'gpt-6-astra', kind: 'text', inputPerMTok: 10, outputPerMTok: 50 },
      {
        model: 'gpt-4o',
        kind: 'text',
        inputPerMTok: 2.5,
        outputPerMTok: 10,
        cachedInputPerMTok: 1.25,
      },
    ]);
  });

  it('reads Claude cache prices with footnotes and ignores narrower batch tables', () => {
    const prices = parseAnthropicPricing(`
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Fable 5.1 | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Mythos 5.1 ([limited availability](https://example.test)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok1 | $50 / MTok |
| Claude Sonnet 5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Fable 5.1 | $5 / MTok | $25 / MTok |
`);
    expect(prices).toHaveLength(3);
    expect(prices[0]).toMatchObject({
      model: 'claude-fable-5-1',
      cachedInputPerMTok: 0.25,
      outputPerMTok: 50,
    });
    expect(prices[1]?.model).toBe('claude-mythos-5-1');
    expect(prices[2]).toEqual({
      model: 'claude-sonnet-5',
      kind: 'text',
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
  });

  it('does not create zero-cost entries from unpriced inputs or non-token units', () => {
    expect(
      parseOpenAIPricing(`Flagship models
Standard
### Standard pricing data
| Model | Input | Output |
| --- | --- | --- |
| unpriced | - | - |
| minute-priced | $1 / minute | $2 / minute |
`),
    ).toEqual([]);
    expect(parseAnthropicPricing('No pricing table')).toEqual([]);
  });
});

describe('manual pricing update dates', () => {
  it('selects effective dated rows before and after a scheduled change regardless of row order', () => {
    const oldRow =
      '| Claude Sonnet 5 [through August 31, 2026](https://example.test) | $2 / MTok | $2.5 / MTok | $4 / MTok | $0.2 / MTok | $10 / MTok |';
    const nextRow =
      '| Claude Sonnet 5 starting September 1, 2026 | $3 / MTok | $3.75 / MTok | $6 / MTok | $0.3 / MTok | $15 / MTok |';
    for (const rows of [
      [oldRow, nextRow],
      [nextRow, oldRow],
    ]) {
      const markdown = rows.join('\n');
      expect(parseAnthropicPricing(markdown, new Date('2026-08-31T23:59:59.999Z'))).toEqual([
        { model: 'claude-sonnet-5', kind: 'text', inputPerMTok: 2, outputPerMTok: 10 },
      ]);
      expect(parseAnthropicPricing(markdown, new Date('2026-09-01T00:00:00Z'))).toEqual([
        { model: 'claude-sonnet-5', kind: 'text', inputPerMTok: 3, outputPerMTok: 15 },
      ]);
    }
  });

  it('keeps an unqualified published rate unchanged', () => {
    const row =
      '| Claude Sonnet 5 | $2 / MTok | $2.5 / MTok | $4 / MTok | $0.2 / MTok | $10 / MTok |';
    expect(parseAnthropicPricing(row, new Date('2026-12-01T00:00:00Z'))[0]?.inputPerMTok).toBe(2);
  });
});
