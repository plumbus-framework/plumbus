import { describe, expect, it } from 'vitest';
import {
  checkOpenAIVoicePricing,
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
      {
        model: 'gpt-6-astra',
        kind: 'text',
        inputPerMTok: 10,
        outputPerMTok: 50,
        longContextThreshold: 272_000,
      },
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

  it('reads a long-context threshold only where the published premium is 2× / 1.5×', () => {
    const prices = parseOpenAIPricing(`Flagship models
Standard
### Standard pricing data
| Model | Short context input | Short context cached input | Short context output | Long context input | Long context cached input | Long context output |
| --- | --- | --- | --- | --- | --- | --- |
| gpt-6.1-sol | $2.00 | $0.10 | $10.00 | $4.00 | $0.20 | $15.00 |
| gpt-5.4 (<128K context length) | $2.50 | $0.25 | $15.00 | $5.00 | $0.50 | $22.50 |
| odd-premium | $1.00 | $0.10 | $4.00 | $3.00 | $0.30 | $8.00 |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 | - | - | - |
`);
    expect(prices.map((price) => [price.model, price.longContextThreshold])).toEqual([
      ['gpt-6.1-sol', 272_000],
      ['gpt-5.4', 128_000],
      ['odd-premium', undefined],
      ['gpt-5.4-mini', undefined],
    ]);
    expect(prices[0]?.cachedInputPerMTok).toBe(0.1);
  });

  it('maps every Specialized category that prices a text model, including Life Sciences', () => {
    const prices = parseOpenAIPricing(`Specialized models
Standard
### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| ChatGPT | chat-latest | $5.00 | $0.50 | $30.00 |
| Life Sciences | gpt-rosalind-research | $5.00 | $0.50 | $25.00 |
Fast
### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Life Sciences | gpt-rosalind-research | $10.00 | $1.00 | $50.00 |
`);
    expect(prices).toEqual([
      { model: 'chat-latest', kind: 'text', inputPerMTok: 5, outputPerMTok: 30 },
      { model: 'gpt-rosalind-research', kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    ]);
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

  it('reads rows whose input and output cells carry footnote markers', () => {
    expect(
      parseAnthropicPricing(`
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
`),
    ).toEqual([
      { model: 'claude-sonnet-5-5', kind: 'text', inputPerMTok: 2, outputPerMTok: 10 },
      { model: 'claude-sonnet-5', kind: 'text', inputPerMTok: 2, outputPerMTok: 10 },
    ]);
  });

  it('preserves the Opus 5.5 five-percent cache-read rate and excludes batch pricing', () => {
    expect(
      parseAnthropicPricing(`
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 5 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Model | Batch input | Batch output |
| --- | --- | --- |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`),
    ).toEqual([
      {
        model: 'claude-opus-5-5',
        kind: 'text',
        inputPerMTok: 4,
        outputPerMTok: 20,
        cachedInputPerMTok: 0.2,
      },
      { model: 'claude-opus-5', kind: 'text', inputPerMTok: 5, outputPerMTok: 25 },
    ]);
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

describe('voice pricing check', () => {
  it('compares @plumbus/voice-openai rates with the per-minute and per-character tables', () => {
    const voice = checkOpenAIVoicePricing(`Realtime and audio generation models
### Grouped Pricing Table data
| Model | Modality | Input | Cached input | Output / cost |
| --- | --- | --- | --- | --- |
| tts-1 | Text | $15.00 / 1M characters | - | - |
| tts-1-hd | Text | $30.00 / 1M characters | - | - |
Transcription models
### Grouped Pricing Table data
| Model | Use case | Input | Output | Estimated cost |
| --- | --- | --- | --- | --- |
| gpt-realtime-whisper | Live transcription | - | - | $0.02 / minute |
| gpt-4o-transcribe | Transcription | $2.50 | $10.00 | $0.006 / minute |
| Whisper | Transcription | - | - | $0.006 / minute |
`);
    expect(Object.fromEntries(voice.map((v) => [v.model, [v.current, v.published]]))).toEqual({
      'whisper-1': [0.006, 0.006],
      'gpt-4o-transcribe': [0.006, 0.006],
      'gpt-realtime-whisper': [0.017, 0.02],
      'tts-1': [15, 15],
      'tts-1-hd': [30, 30],
    });
  });

  it('reports a voice rate the page no longer lists', () => {
    const voice = checkOpenAIVoicePricing('No pricing table');
    expect(voice.every((v) => v.published === null)).toBe(true);
  });
});
