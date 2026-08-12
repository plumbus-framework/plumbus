import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPricingStore,
  extractModelIdFromOfferAttrs,
  inferFamilyFromDisplayName,
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

describe('extractModelIdFromOfferAttrs', () => {
  it('prefers SDK-shaped model attribute', () => {
    expect(
      extractModelIdFromOfferAttrs({
        model: 'amazon.titan-embed-text-v2:0',
        servicename: 'ignored display name',
      }),
    ).toBe('amazon.titan-embed-text-v2');
  });

  it('extracts id embedded in usagetype', () => {
    expect(
      extractModelIdFromOfferAttrs({
        usagetype: 'USE1-google.gemma-3-4b-it-mantle-input-tokens-standard',
      }),
    ).toBe('google.gemma-3-4b-it');
  });

  it('accepts any structural provider.model id (no vendor allowlist)', () => {
    expect(
      extractModelIdFromOfferAttrs({
        model: 'acme.future-model-9000:0',
      }),
    ).toBe('acme.future-model-9000');
  });

  it('returns null when only a marketing display name is present', () => {
    expect(
      extractModelIdFromOfferAttrs({
        servicename: 'Some Unknown Marketing Name',
        usagetype: 'USE1-MP:USE1_InputTokenCount-Units',
      }),
    ).toBeNull();
  });
});

describe('inferFamilyFromDisplayName', () => {
  it('infers Claude and Titan shapes without a hardcoded catalog table', () => {
    expect(inferFamilyFromDisplayName('Claude Haiku 4.5 (Amazon Bedrock Edition)')).toEqual({
      family: 'anthropic.claude-haiku-4-5',
      kind: 'text',
    });
    expect(inferFamilyFromDisplayName('Claude 3.5 Sonnet')).toEqual({
      family: 'anthropic.claude-3-5-sonnet',
      kind: 'text',
    });
    expect(inferFamilyFromDisplayName('Titan Text Embeddings V2')).toEqual({
      family: 'amazon.titan-embed-text-v2',
      kind: 'embedding',
    });
    expect(inferFamilyFromDisplayName('Amazon Nova Lite')).toEqual({
      family: 'amazon.nova-lite',
      kind: 'text',
    });
    expect(inferFamilyFromDisplayName('Completely Unknown Model XYZ')).toBeNull();
  });

  // Shapes taken verbatim from the real us-east-1 AmazonBedrock offer index,
  // where the model name lives in `titanModel` and runs words together.
  it('infers the Titan embedding shapes that real offer rows actually use', () => {
    expect(inferFamilyFromDisplayName('TitanEmbeddingsV2-Text-input')).toEqual({
      family: 'amazon.titan-embed-text-v2',
      kind: 'embedding',
    });
    expect(inferFamilyFromDisplayName('Titan Embeddings G1 Text')).toEqual({
      family: 'amazon.titan-embed-text-v1',
      kind: 'embedding',
    });
    expect(inferFamilyFromDisplayName('Titan Embeddings G1 Image')).toEqual({
      family: 'amazon.titan-embed-image-v1',
      kind: 'embedding',
    });
    // Not an embedding model — must not be keyed as one.
    expect(inferFamilyFromDisplayName('Titan Text G1 Lite')).toBeNull();
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
  it('maps FoundationModels Haiku via generative display inference', () => {
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

  it('prefers SDK model id from attributes over display names', () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            model: 'amazon.nova-lite-v1:0',
            servicename: 'Some Display Name',
            inferenceType: 'Input tokens',
            feature: 'On-demand Inference',
            usagetype: 'USE1-Something',
          },
        },
        sku2: {
          attributes: {
            model: 'amazon.nova-lite-v1:0',
            inferenceType: 'Output tokens',
            feature: 'On-demand Inference',
            usagetype: 'USE1-Something',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '0.06' } },
              },
            },
          },
          sku2: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '0.24' } },
              },
            },
          },
        },
      },
    };
    const rates = parseAwsOfferRates([offer]);
    expect(rates.get('amazon.nova-lite-v1')).toEqual({
      inputPerMTok: 0.06,
      outputPerMTok: 0.24,
      kind: 'text',
    });
  });

  it('keys rates from usagetype-embedded model ids', () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            usagetype: 'USE1-anthropic.claude-sonnet-4-5-mantle-input-tokens-standard',
          },
        },
        sku2: {
          attributes: {
            usagetype: 'USE1-anthropic.claude-sonnet-4-5-mantle-output-tokens-standard',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '3' } },
              },
            },
          },
          sku2: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '15' } },
              },
            },
          },
        },
      },
    };
    const rates = parseAwsOfferRates([offer]);
    expect(rates.get('anthropic.claude-sonnet-4-5')).toEqual({
      inputPerMTok: 3,
      outputPerMTok: 15,
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

  it('keys first-party Titan embedding rows from the titanModel attribute', () => {
    // Real shape: servicename is the literal "Amazon Bedrock", the model name is
    // only in `titanModel`, and the unit is per 1K tokens.
    const offer = {
      products: {
        sku1: {
          attributes: {
            servicename: 'Amazon Bedrock',
            titanModel: 'TitanEmbeddingsV2-Text-input',
            feature: 'On-demand Inference',
            inferenceType: 'Input tokens',
            usagetype: 'USE1-TitanEmbeddingV2-Text-input-tokens',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1K tokens', pricePerUnit: { USD: '0.0000200000' } },
              },
            },
          },
        },
      },
    };
    const rates = parseAwsOfferRates([offer]);
    expect(rates.get('amazon.titan-embed-text-v2')).toEqual({
      inputPerMTok: 0.02,
      outputPerMTok: 0,
      kind: 'embedding',
    });
  });

  it('skips rows whose unit is not a token unit', () => {
    // Offer files carry hour / image / Model-month / TPM-hour rows for the same
    // families; treating one as a token price is wrong by orders of magnitude.
    const offer = {
      products: {
        sku1: {
          attributes: {
            usagetype: 'USE1-anthropic.claude-sonnet-4-5-mantle-input-tokens-standard',
          },
        },
        sku2: {
          attributes: {
            usagetype: 'USE1-acme.widget-model-input-tokens-standard',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: { priceDimensions: { p1: { unit: '1M tokens', pricePerUnit: { USD: '3' } } } },
          },
          sku2: {
            // Provisioned-throughput style unit — must not become a token rate.
            d1: { priceDimensions: { p1: { unit: '1M TPM Hour', pricePerUnit: { USD: '0.18' } } } },
          },
        },
      },
    };
    const rates = parseAwsOfferRates([offer]);
    expect(rates.get('anthropic.claude-sonnet-4-5')?.inputPerMTok).toBe(3);
    expect(rates.has('acme.widget-model')).toBe(false);
  });

  it('picks the lowest standard-tier rate regardless of product order', () => {
    const makeOffer = (first: string, second: string) => ({
      products: {
        [first]: {
          attributes: { usagetype: 'USE1-acme.model-a-mantle-input-tokens-standard' },
        },
        [second]: {
          attributes: { usagetype: 'USE1-acme.model-a-mantle-input-tokens-standard' },
        },
      },
      terms: {
        OnDemand: {
          [first]: {
            d1: { priceDimensions: { p1: { unit: '1M tokens', pricePerUnit: { USD: '9' } } } },
          },
          [second]: {
            d1: { priceDimensions: { p1: { unit: '1M tokens', pricePerUnit: { USD: '3' } } } },
          },
        },
      },
    });
    // JSON key order must not decide the rate.
    expect(parseAwsOfferRates([makeOffer('skuA', 'skuB')]).get('acme.model-a')?.inputPerMTok).toBe(
      3,
    );
    expect(parseAwsOfferRates([makeOffer('skuB', 'skuA')]).get('acme.model-a')?.inputPerMTok).toBe(
      3,
    );
  });

  it('captures regional cache and global inference-profile SKUs', () => {
    // usagetype shapes taken from the real FoundationModels index.
    const row = (usagetype: string) => ({
      attributes: { servicename: 'Claude Haiku 4.5', usagetype },
    });
    const price = (usd: string) => ({
      d1: { priceDimensions: { p1: { unit: '1M tokens', pricePerUnit: { USD: usd } } } },
    });
    const offer = {
      products: {
        i: row('USE1-MP:USE1_InputTokenCount-Units'),
        o: row('USE1-MP:USE1_OutputTokenCount-Units'),
        cr: row('USE1-MP:USE1_CacheReadInputTokenCount-Units'),
        cw: row('USE1-MP:USE1_CacheWriteInputTokenCount-Units'),
        cw1h: row('USE1-MP:USE1_CacheWrite1hInputTokenCount-Units'),
        gi: row('USE1-MP:USE1_InputTokenCount_Global-Units'),
        go: row('USE1-MP:USE1_OutputTokenCount_Global-Units'),
      },
      terms: {
        OnDemand: {
          i: price('1.1'),
          o: price('5.5'),
          cr: price('0.11'),
          cw: price('1.375'),
          cw1h: price('2.2'),
          gi: price('1'),
          go: price('5'),
        },
      },
    };
    const rate = parseAwsOfferRates([offer]).get('anthropic.claude-haiku-4-5');
    expect(rate).toEqual({
      inputPerMTok: 1.1,
      outputPerMTok: 5.5,
      kind: 'text',
      cacheReadPerMTok: 0.11,
      cacheWritePerMTok: 1.375,
      globalInputPerMTok: 1,
      globalOutputPerMTok: 5,
    });
    // The 1-hour cache write is a higher tier and must not overwrite the 5m rate.
    expect(rate?.cacheWritePerMTok).not.toBe(2.2);
  });

  it('skips unknown marketing names with no extractable id', () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            servicename: 'Mysterious Future Model 9000',
            usagetype: 'USE1-MP:USE1_InputTokenCount-Units',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: {
              priceDimensions: {
                p1: { unit: '1M tokens', pricePerUnit: { USD: '9' } },
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

    // Bedrock reports cache tokens OUTSIDE inputTokens, so they bill additively:
    // 1M standard + 400k cached (0.1×) + 100k write (1.25×) = 1M + 40k + 125k = 1.165M @ $1/MTok
    expect(
      store.calculateCost('anthropic.claude-haiku-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 100_000,
      }),
    ).toBe(1.165);

    // 4 tokens of Titan at $0.02/MTok must not round to 0
    const tiny = store.calculateCost('amazon.titan-embed-text-v2:0', {
      inputTokens: 4,
      outputTokens: 0,
    });
    expect(tiny).toBeGreaterThan(0);
    expect(tiny).toBeCloseTo(0.00000008, 10);
  });

  it('prefers published cache rates over multipliers, and global rates for global. ids', async () => {
    const dir = join(tmpdir(), `plumbus-bedrock-pricing-tiers-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          'anthropic.claude-haiku-4-5': {
            inputPerMTok: 1,
            outputPerMTok: 1,
            kind: 'text',
            cacheReadPerMTok: 0.5, // deliberately unlike the 0.1x multiplier
            cacheWritePerMTok: 2, // deliberately unlike the 1.25x multiplier
            globalInputPerMTok: 0.5,
            globalOutputPerMTok: 0.5,
          },
          'amazon.nova-lite': { inputPerMTok: 1, outputPerMTok: 1, kind: 'text' },
        },
      }),
    );
    const store = createPricingStore({ region: 'us-east-1', pricingFilePath: file });
    await store.warm();

    // 1M input + 1M cached @0.5 + 1M write @2 = 1 + 0.5 + 2 = 3.5
    expect(
      store.calculateCost('anthropic.claude-haiku-4-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(3.5);

    // No published cache rates → multiplier fallback: 1 + 0.1 + 1.25 = 2.35
    expect(
      store.calculateCost('amazon.nova-lite', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(2.35);

    // Global inference profile bills below the regional rate.
    expect(
      store.calculateCost('global.anthropic.claude-haiku-4-5-20251001-v1:0', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(1);
    // A regional/geo id keeps the regional rate.
    expect(
      store.calculateCost('us.anthropic.claude-haiku-4-5-20251001-v1:0', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBe(2);
  });

  it('returns undefined (not 0) when no rate is known for the model', async () => {
    const dir = join(tmpdir(), `plumbus-bedrock-pricing-unknown-${Date.now()}`);
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
    const store = createPricingStore({ region: 'us-east-1', pricingFilePath: file });
    await store.warm();

    // $0 would be recorded by core as real-but-free spend; unknown must stay unknown.
    expect(
      store.calculateCost('meta.llama3-70b-instruct-v1:0', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeUndefined();
  });

  it('resolves versioned model ids against version-less family keys', async () => {
    const dir = join(tmpdir(), `plumbus-bedrock-pricing-family-${Date.now()}`);
    dirs.push(dir);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'pricing.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        models: {
          // Display-name inference produces this version-less shape.
          'amazon.nova-lite': { inputPerMTok: 0.06, outputPerMTok: 0.24, kind: 'text' },
          'amazon.titan-embed-text-v2': { inputPerMTok: 0.02, outputPerMTok: 0, kind: 'embedding' },
        },
      }),
    );
    const store = createPricingStore({ region: 'us-east-1', pricingFilePath: file });
    await store.warm();

    // `amazon.nova-lite-v1:0` normalizes to `amazon.nova-lite-v1` — must still hit.
    expect(store.getRate('amazon.nova-lite-v1:0')?.inputPerMTok).toBe(0.06);
    expect(store.getRate('us.amazon.nova-lite-v1:0')?.inputPerMTok).toBe(0.06);
    // A genuinely versioned key still wins over the version-less fallback.
    expect(store.getRate('amazon.titan-embed-text-v2:0')?.inputPerMTok).toBe(0.02);
  });

  it('backs off instead of refetching the Price List on every warm after a failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ENETUNREACH'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const store = createPricingStore({
        region: 'us-east-1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await store.warm();
      const afterFirst = fetchImpl.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      // Subsequent requests must not re-pay the fetch timeout during the cooldown.
      await store.warm();
      await store.warm();
      expect(fetchImpl.mock.calls.length).toBe(afterFirst);
      expect(
        store.calculateCost('anthropic.claude-haiku-4-5', { inputTokens: 10, outputTokens: 10 }),
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('serves stale rates and refreshes off the request path once the TTL expires', async () => {
    const offer = {
      products: {
        sku1: {
          attributes: {
            usagetype: 'USE1-anthropic.claude-haiku-4-5-mantle-input-tokens-standard',
          },
        },
      },
      terms: {
        OnDemand: {
          sku1: {
            d1: { priceDimensions: { p1: { unit: '1M tokens', pricePerUnit: { USD: '1.1' } } } },
          },
        },
      },
    };
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (fetchImpl.mock.calls.length > 2) {
        // Second round: block until released, proving warm() did not await it.
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { ok: true, json: async () => offer } as unknown as Response;
    });

    const store = createPricingStore({
      region: 'us-east-1',
      pricingCacheTtlMs: -1, // always stale
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await store.warm();
    expect(store.getRate('anthropic.claude-haiku-4-5')?.inputPerMTok).toBe(1.1);

    // Stale now: this must return immediately with the cached rate still served.
    await store.warm();
    expect(store.getRate('anthropic.claude-haiku-4-5')?.inputPerMTok).toBe(1.1);
    release?.();
  });
});
