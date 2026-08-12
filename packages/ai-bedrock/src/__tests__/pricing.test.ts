import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPricingStore,
  normalizeBedrockModelId,
  parseAwsOfferRates,
  parsePricingFile,
} from '../pricing.js';

describe('normalizeBedrockModelId', () => {
  it('strips geo prefix and version suffix', () => {
    expect(normalizeBedrockModelId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(
      'anthropic.claude-haiku-4-5',
    );
    expect(normalizeBedrockModelId('amazon.titan-embed-text-v2:0')).toBe(
      'amazon.titan-embed-text-v2',
    );
  });
});

describe('parsePricingFile', () => {
  it('loads normalized v1 schema', () => {
    const rates = parsePricingFile({
      version: 1,
      region: 'us-east-1',
      models: {
        'anthropic.claude-haiku-4-5': {
          inputPerMTok: 1.1,
          outputPerMTok: 5.5,
          kind: 'text',
        },
      },
    });
    expect(rates.get('anthropic.claude-haiku-4-5')?.inputPerMTok).toBe(1.1);
  });

  it('rejects bad version', () => {
    expect(() => parsePricingFile({ version: 2, models: {} })).toThrow(/version/);
  });
});

describe('parseAwsOfferRates', () => {
  it('maps FoundationModels Haiku 4.5 regional on-demand to family key at $1.10', () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            servicename: 'Claude Haiku 4.5 (Amazon Bedrock Edition)',
            usagetype: 'USE1-MP:USE1_InputTokenCount-Units',
          },
        },
        sku2: {
          attributes: {
            servicename: 'Claude Haiku 4.5 (Amazon Bedrock Edition)',
            usagetype: 'USE1-MP:USE1_OutputTokenCount-Units',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '1.1000000000' } },
              },
            },
          },
          sku2: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '5.5000000000' } },
              },
            },
          },
        },
      },
    };
    const rates = parseAwsOfferRates([offer]);
    expect(rates.get('anthropic.claude-haiku-4-5')).toEqual({
      inputPerMTok: 1.1,
      outputPerMTok: 5.5,
      kind: 'text',
    });
  });

  it('ignores Global and Batch SKUs', () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            servicename: 'Claude Haiku 4.5 (Amazon Bedrock Edition)',
            usagetype: 'USE1-MP:USE1_InputTokenCount_Global-Units',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '1.0000000000' } },
              },
            },
          },
        },
      },
    };
    expect(parseAwsOfferRates([offer]).size).toBe(0);
  });
});

describe('createPricingStore', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const d of dirs.splice(0)) {
      await rm(d, { recursive: true, force: true });
    }
  });

  it('loads pricingFilePath and skips fetch', async () => {
    const dir = join(tmpdir(), `plumbus-bedrock-pricing-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          'anthropic.claude-haiku-4-5': { inputPerMTok: 1.1, outputPerMTok: 5.5, kind: 'text' },
        },
      }),
    );

    const fetchImpl = vi.fn();
    const store = createPricingStore({
      region: 'us-east-1',
      pricingFilePath: file,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await store.warm();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      store.calculateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', {
        inputTokens: 1_000_000,
        outputTokens: 0,
      }),
    ).toBe(1.1);
  });

  it('applies cache read/write multipliers and keeps sub-cent embed precision', async () => {
    const dir = join(tmpdir(), `plumbus-bedrock-pricing-cache-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          'anthropic.claude-haiku-4-5': { inputPerMTok: 1.0, outputPerMTok: 1.0, kind: 'text' },
          'amazon.titan-embed-text-v2': { inputPerMTok: 0.02, outputPerMTok: 0, kind: 'embedding' },
        },
      }),
    );
    const store = createPricingStore({ region: 'us-east-1', pricingFilePath: file });
    await store.warm();

    // 500k standard + 400k cached (0.1×) + 100k write (1.25×) = 500k + 40k + 125k = 665k @ $1/MTok
    expect(
      store.calculateCost('anthropic.claude-haiku-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBe(0.665);

    // 4 tokens of Titan at $0.02/MTok must not round to 0
    const tiny = store.calculateCost('amazon.titan-embed-text-v2:0', {
      inputTokens: 4,
      outputTokens: 0,
    });
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeCloseTo(0.00000008, 10);
  });
});
