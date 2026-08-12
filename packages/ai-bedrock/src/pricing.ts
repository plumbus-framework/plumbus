import { readFile } from 'node:fs/promises';
import type { BedrockModelRate, BedrockPricingFileV1 } from './types.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;

/** Display / service names from AWS offer JSON → Bedrock model family keys. */
const DISPLAY_NAME_TO_FAMILY: ReadonlyArray<{
  match: RegExp;
  family: string;
  kind: BedrockModelRate['kind'];
}> = [
  { match: /claude\s*haiku\s*4\.5/i, family: 'anthropic.claude-haiku-4-5', kind: 'text' },
  { match: /claude\s*sonnet\s*4\.5/i, family: 'anthropic.claude-sonnet-4-5', kind: 'text' },
  { match: /claude\s*sonnet\s*4(?!\.\d)/i, family: 'anthropic.claude-sonnet-4', kind: 'text' },
  { match: /claude\s*opus\s*4\.5/i, family: 'anthropic.claude-opus-4-5', kind: 'text' },
  { match: /claude\s*opus\s*4(?!\.\d)/i, family: 'anthropic.claude-opus-4', kind: 'text' },
  { match: /claude\s*3\.5\s*haiku/i, family: 'anthropic.claude-3-5-haiku', kind: 'text' },
  { match: /claude\s*3\.5\s*sonnet/i, family: 'anthropic.claude-3-5-sonnet', kind: 'text' },
  { match: /claude\s*3\s*haiku/i, family: 'anthropic.claude-3-haiku', kind: 'text' },
  { match: /claude\s*3\s*sonnet/i, family: 'anthropic.claude-3-sonnet', kind: 'text' },
  { match: /claude\s*3\s*opus/i, family: 'anthropic.claude-3-opus', kind: 'text' },
  {
    match: /titan\s*text\s*embeddings?\s*v2|titan\s*embed\s*text\s*v2/i,
    family: 'amazon.titan-embed-text-v2',
    kind: 'embedding',
  },
  {
    match: /titan\s*embed\s*text\s*v1|titan\s*text\s*embeddings?\s*g1/i,
    family: 'amazon.titan-embed-text-v1',
    kind: 'embedding',
  },
];

export interface PricingStoreOptions {
  region: string;
  pricingFilePath?: string;
  pricingCacheTtlMs?: number;
  pricingRefreshTimeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

export interface BedrockPricingStore {
  /** Ensure rates are loaded (file or network). Safe to call repeatedly. */
  warm: () => Promise<void>;
  getRate: (modelId: string) => BedrockModelRate | null;
  listRates: () => Array<{ id: string; rate: BedrockModelRate }>;
  calculateCost: (
    modelId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ) => number;
}

/**
 * Normalize a Bedrock model id to a family key for rate lookup.
 * Examples:
 * - `us.anthropic.claude-haiku-4-5-20251001-v1:0` → `anthropic.claude-haiku-4-5`
 * - `amazon.titan-embed-text-v2:0` → `amazon.titan-embed-text-v2`
 */
export function normalizeBedrockModelId(modelId: string): string {
  let id = modelId.trim();
  id = id.replace(/^(us|eu|apac|ap|sa|ca|me|af|il|global)\./i, '');
  // Dated inference ids: …-20251001-v1:0
  id = id.replace(/-\d{8}-v\d+:\d+$/i, '');
  // Trailing :0 / :1 only (keep model revision suffixes like -v2)
  id = id.replace(/:\d+$/i, '');
  return id;
}

function familyFromDisplayName(
  name: string,
): { family: string; kind: BedrockModelRate['kind'] } | null {
  for (const entry of DISPLAY_NAME_TO_FAMILY) {
    if (entry.match.test(name)) {
      return { family: entry.family, kind: entry.kind };
    }
  }
  return null;
}

function toPerMTok(priceUsd: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.includes('1m') || u.includes('million')) return priceUsd;
  if (u.includes('1k') || u.includes('thousand')) return priceUsd * 1000;
  // Assume already per-token USD → convert to per MTok
  if (u === 'tokens' || u === 'token') return priceUsd * 1_000_000;
  return priceUsd;
}

interface OfferProductAttrs {
  model?: string;
  servicename?: string;
  feature?: string;
  inferenceType?: string;
  usagetype?: string;
  provider?: string;
  service_tier?: string;
}

interface OfferPriceDimension {
  unit?: string;
  description?: string;
  pricePerUnit?: { USD?: string };
}

interface OfferTermDimension {
  priceDimensions?: Record<string, OfferPriceDimension>;
}

interface OfferJson {
  products: Record<string, { attributes?: OfferProductAttrs }>;
  terms?: { OnDemand?: Record<string, Record<string, OfferTermDimension>> };
}

function isRegionalStandardInput(attrs: OfferProductAttrs): boolean {
  const usage = attrs.usagetype ?? '';
  if (/Global|Batch|LatencyOptimized|Reserved|Cache/i.test(usage)) return false;
  if (attrs.feature && !/on-demand/i.test(attrs.feature) && attrs.feature !== '') return false;
  if (attrs.service_tier && /priority|flex/i.test(attrs.service_tier)) return false;
  return true;
}

function isInputInference(attrs: OfferProductAttrs): boolean {
  const inf = attrs.inferenceType ?? '';
  const usage = attrs.usagetype ?? '';
  if (/input\s*tokens?/i.test(inf) && !/priority|flex|batch|cache/i.test(inf)) return true;
  if (/InputTokenCount-Units$/i.test(usage)) return true;
  return false;
}

function isOutputInference(attrs: OfferProductAttrs): boolean {
  const inf = attrs.inferenceType ?? '';
  const usage = attrs.usagetype ?? '';
  if (/output\s*tokens?/i.test(inf) && !/priority|flex|batch|cache/i.test(inf)) return true;
  if (/OutputTokenCount-Units$/i.test(usage) || /ResponseTokenCount-Units$/i.test(usage))
    return true;
  return false;
}

function displayNameFromAttrs(attrs: OfferProductAttrs): string {
  return attrs.model ?? attrs.servicename ?? '';
}

function extractOnDemandPrice(offer: OfferJson, sku: string): { usd: number; unit: string } | null {
  const onDemand = offer.terms?.OnDemand?.[sku];
  if (!onDemand) return null;
  for (const dim of Object.values(onDemand)) {
    const dims = dim.priceDimensions;
    if (!dims) continue;
    for (const pd of Object.values(dims)) {
      const raw = pd.pricePerUnit?.USD;
      if (raw == null) continue;
      const usd = Number.parseFloat(raw);
      if (!Number.isFinite(usd)) continue;
      return { usd, unit: pd.unit ?? '1M tokens' };
    }
  }
  return null;
}

/** Parse AWS offer JSON(s) into family-keyed rates (regional on-demand only). */
export function parseAwsOfferRates(offers: OfferJson[]): Map<string, BedrockModelRate> {
  const input = new Map<string, { perMTok: number; kind: BedrockModelRate['kind'] }>();
  const output = new Map<string, number>();

  for (const offer of offers) {
    for (const [sku, product] of Object.entries(offer.products ?? {})) {
      const attrs = product.attributes ?? {};
      if (!isRegionalStandardInput(attrs)) continue;
      const display = displayNameFromAttrs(attrs);
      if (!display) continue;
      const mapped = familyFromDisplayName(display);
      if (!mapped) continue;
      const price = extractOnDemandPrice(offer, sku);
      if (!price) continue;
      const perMTok = toPerMTok(price.usd, price.unit);

      if (isInputInference(attrs)) {
        const prev = input.get(mapped.family);
        // Prefer FoundationModels-style higher specificity when already set; keep first
        if (!prev) input.set(mapped.family, { perMTok, kind: mapped.kind });
      } else if (isOutputInference(attrs)) {
        if (!output.has(mapped.family)) output.set(mapped.family, perMTok);
      }
    }
  }

  const rates = new Map<string, BedrockModelRate>();
  for (const [family, inp] of input) {
    rates.set(family, {
      inputPerMTok: inp.perMTok,
      outputPerMTok: output.get(family) ?? 0,
      kind: inp.kind,
    });
  }
  return rates;
}

export function parsePricingFile(raw: unknown): Map<string, BedrockModelRate> {
  if (raw == null || typeof raw !== 'object') {
    throw new Error('Bedrock pricing file must be a JSON object');
  }
  const doc = raw as Partial<BedrockPricingFileV1>;
  if (doc.version !== 1) {
    throw new Error(`Unsupported Bedrock pricing file version: ${String(doc.version)}`);
  }
  if (doc.models == null || typeof doc.models !== 'object') {
    throw new Error('Bedrock pricing file must include a "models" object');
  }
  const rates = new Map<string, BedrockModelRate>();
  for (const [id, rate] of Object.entries(doc.models)) {
    if (rate == null || typeof rate !== 'object') continue;
    if (typeof rate.inputPerMTok !== 'number' || typeof rate.outputPerMTok !== 'number') {
      throw new Error(
        `Invalid rate for model "${id}": inputPerMTok and outputPerMTok are required numbers`,
      );
    }
    rates.set(id, {
      inputPerMTok: rate.inputPerMTok,
      outputPerMTok: rate.outputPerMTok,
      kind: rate.kind,
    });
    // Also index by normalized family so versioned ids resolve.
    const family = normalizeBedrockModelId(id);
    const copied = rates.get(id);
    if (family !== id && copied != null && !rates.has(family)) {
      rates.set(family, copied);
    }
  }
  return rates;
}

async function fetchOfferJson(
  region: string,
  service: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<OfferJson | null> {
  const url = `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/${service}/current/${region}/index.json`;
  try {
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
      console.warn(`[plumbus/ai-bedrock] Price List fetch ${service} returned ${resp.status}`);
      return null;
    }
    return (await resp.json()) as OfferJson;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[plumbus/ai-bedrock] Price List fetch ${service} failed (${msg})`);
    return null;
  }
}

export function createPricingStore(options: PricingStoreOptions): BedrockPricingStore {
  const ttlMs = options.pricingCacheTtlMs ?? DEFAULT_TTL_MS;
  const refreshTimeoutMs = options.pricingRefreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let rates = new Map<string, BedrockModelRate>();
  let loadedAt = 0;
  let warmPromise: Promise<void> | null = null;

  function lookup(modelId: string): BedrockModelRate | null {
    const exact = rates.get(modelId);
    if (exact) return exact;
    const family = normalizeBedrockModelId(modelId);
    return rates.get(family) ?? null;
  }

  async function loadFromFile(path: string): Promise<void> {
    const text = await readFile(path, 'utf8');
    const json: unknown = JSON.parse(text);
    rates = parsePricingFile(json);
    loadedAt = Date.now();
  }

  async function loadFromNetwork(): Promise<void> {
    const [bedrock, foundation] = await Promise.all([
      fetchOfferJson(options.region, 'AmazonBedrock', fetchImpl, refreshTimeoutMs),
      fetchOfferJson(options.region, 'AmazonBedrockFoundationModels', fetchImpl, refreshTimeoutMs),
    ]);
    const offers = [bedrock, foundation].filter((o): o is OfferJson => o != null);
    if (offers.length === 0) {
      console.warn(
        `[plumbus/ai-bedrock] Could not download Price List for region ${options.region}; costs will be $0 until rates are available`,
      );
      return;
    }
    rates = parseAwsOfferRates(offers);
    loadedAt = Date.now();
  }

  async function warm(): Promise<void> {
    if (options.pricingFilePath) {
      if (rates.size > 0 && loadedAt > 0) return;
      await loadFromFile(options.pricingFilePath);
      return;
    }
    const stale = loadedAt === 0 || Date.now() - loadedAt > ttlMs;
    if (!stale) return;
    await loadFromNetwork();
  }

  return {
    warm: () => {
      if (!warmPromise) {
        warmPromise = warm().finally(() => {
          warmPromise = null;
        });
      }
      return warmPromise;
    },
    getRate: lookup,
    listRates: () => [...rates.entries()].map(([id, rate]) => ({ id, rate })),
    calculateCost: (modelId, usage) => {
      const rate = lookup(modelId);
      if (!rate) return 0;
      const cached = usage.cachedInputTokens ?? 0;
      const cacheWrites = usage.cacheWriteTokens ?? 0;
      const standardInput = Math.max(0, usage.inputTokens - cached - cacheWrites);
      // Approximate Anthropic-style cache multipliers when Bedrock reports cache tokens.
      const inputCost =
        standardInput * rate.inputPerMTok +
        cached * rate.inputPerMTok * 0.1 +
        cacheWrites * rate.inputPerMTok * 1.25;
      const outputCost = usage.outputTokens * rate.outputPerMTok;
      return Number(((inputCost + outputCost) / 1_000_000).toFixed(10));
    },
  };
}
