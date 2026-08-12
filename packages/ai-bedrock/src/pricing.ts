import { readFile } from 'node:fs/promises';
import type { BedrockModelRate, BedrockPricingFileV1 } from './types.js';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
/**
 * Cooldown after a failed auto-download before the next attempt. Without this
 * every request would re-pay the fetch timeout when the Price List CDN is
 * unreachable (locked-down clusters), since a failed load leaves rates empty.
 */
const FAILED_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Structural shape of a Bedrock SDK model id: `provider.model…`
 * (optional geo inference-profile prefix `us.` / `eu.` / …).
 *
 * No provider/model allowlist — anything matching this shape is treated as an
 * id. Marketing display names (spaces, no `provider.model` form) do not match.
 */
const SDK_MODEL_ID_SHAPE =
  /^(?:(?:us|eu|apac|ap|sa|ca|me|af|il|global)\.)?[a-z]{2,}\.[a-z0-9][a-z0-9._:-]*$/i;

/** Find the same shape inside a longer string (e.g. Price List usagetype). */
const SDK_MODEL_ID_IN_TEXT =
  /\b((?:(?:us|eu|apac|ap|sa|ca|me|af|il|global)\.)?[a-z]{2,}\.[a-z0-9][a-z0-9._-]*)/i;

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
  /**
   * USD for a usage record, or `undefined` when no rate is known for the model.
   *
   * `undefined` (not `0`) is deliberate: core prefers an adapter-supplied `cost`
   * over its own catalog with `providerCost ?? calculateModelCost(...)`, so a
   * `0` for an unpriced model would silently record real spend as free in the
   * ledger and against daily cost limits.
   */
  calculateCost: (
    modelId: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens?: number;
      cacheWriteTokens?: number;
    },
  ) => number | undefined;
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

function looksLikeSdkModelId(value: string): boolean {
  const v = value.trim();
  if (!v || /\s/.test(v)) return false;
  return SDK_MODEL_ID_SHAPE.test(v);
}

function stripPricingSuffixFromId(raw: string): string {
  let id = raw;
  id = id.replace(/-(?:mantle-)?(?:input|output)[_-]tokens.*$/i, '');
  id = id.replace(/-(?:Input|Output|Response)TokenCount.*$/i, '');
  id = id.replace(/-(?:input|output)_tokens_.*$/i, '');
  return id;
}

/**
 * Prefer SDK-shaped ids already present in offer attributes / usagetype.
 * Returns a normalized family key, or null.
 *
 * Recognition is structural (`provider.model…`) — not an allowlist of vendors.
 */
export function extractModelIdFromOfferAttrs(attrs: {
  model?: string;
  modelId?: string;
  servicename?: string;
  usagetype?: string;
}): string | null {
  for (const candidate of [attrs.modelId, attrs.model]) {
    if (candidate && looksLikeSdkModelId(candidate)) {
      return normalizeBedrockModelId(stripPricingSuffixFromId(candidate.trim()));
    }
  }
  const usage = attrs.usagetype ?? '';
  const embedded = usage.match(SDK_MODEL_ID_IN_TEXT);
  if (embedded?.[1]) {
    return normalizeBedrockModelId(stripPricingSuffixFromId(embedded[1]));
  }
  return null;
}

function inferKind(family: string): BedrockModelRate['kind'] {
  if (/embed/i.test(family)) return 'embedding';
  return 'text';
}

/**
 * Last-resort generative inference from marketplace display names.
 * Not a hardcoded catalog of every AWS model — only a few stable name shapes
 * (Claude tier+version, Titan embed). Prefer pricing files or extracted ids.
 */
export function inferFamilyFromDisplayName(
  name: string,
): { family: string; kind: BedrockModelRate['kind'] } | null {
  const n = name.trim();
  if (!n) return null;

  // "Claude Haiku 4.5 (Amazon Bedrock Edition)" / "Claude Sonnet 4"
  let m = n.match(/claude\s+(haiku|sonnet|opus)\s+(\d+(?:\.\d+)?)/i);
  if (m?.[1] && m[2]) {
    const tier = m[1].toLowerCase();
    const ver = m[2].replace(/\./g, '-');
    return { family: `anthropic.claude-${tier}-${ver}`, kind: 'text' };
  }

  // "Claude 3.5 Haiku" / "Claude 3 Sonnet"
  m = n.match(/claude\s+(\d+(?:\.\d+)?)\s+(haiku|sonnet|opus)/i);
  if (m?.[1] && m[2]) {
    const ver = m[1].replace(/\./g, '-');
    const tier = m[2].toLowerCase();
    return { family: `anthropic.claude-${ver}-${tier}`, kind: 'text' };
  }

  // Titan embeddings. Offer rows spell these several ways and often only in the
  // `titanModel` attribute: "Titan Text Embeddings V2", "Titan Embed Text V1",
  // "TitanEmbeddingsV2-Text-input", "Titan Embeddings G1 Text".
  if (/titan/i.test(n) && /embed/i.test(n)) {
    const modality = /image|multimodal/i.test(n) ? 'image' : 'text';
    // No \b before v — real rows run it together ("TitanEmbeddingsV2-Text-input").
    const version = n.match(/v(\d+)/i)?.[1] ?? (/\bg1\b/i.test(n) ? '1' : null);
    if (version) {
      return { family: `amazon.titan-embed-${modality}-v${version}`, kind: 'embedding' };
    }
  }

  // "Amazon Nova Lite" / "Nova Pro"
  m = n.match(/\bnova\s+(micro|lite|pro|premier)\b/i);
  if (m?.[1]) {
    return { family: `amazon.nova-${m[1].toLowerCase()}`, kind: 'text' };
  }

  return null;
}

function resolveFamily(attrs: OfferProductAttrs): {
  family: string;
  kind: BedrockModelRate['kind'];
} | null {
  const extracted = extractModelIdFromOfferAttrs(attrs);
  if (extracted) {
    return { family: extracted, kind: inferKind(extracted) };
  }
  // `servicename` is the literal "Amazon Bedrock" on first-party rows, so the
  // model name lives in `model` / `titanModel` there.
  const display = attrs.model ?? attrs.titanModel ?? attrs.servicename ?? '';
  return inferFamilyFromDisplayName(display);
}

/**
 * Convert a Price List unit to USD per 1M tokens, or null when the unit is not
 * a token unit at all.
 *
 * Returning null (rather than assuming per-MTok) matters: offer files also
 * carry `hour`, `image`, `Model/month`, `Search Units`, `1M TPM Hour` and
 * friends, and silently treating one of those as a token rate would be wrong
 * by orders of magnitude in the ledger. A skipped row simply has no rate.
 */
function toPerMTok(priceUsd: number, unit: string): number | null {
  const u = unit.toLowerCase().trim();
  // "1M TPM Hour" is a provisioned-throughput unit, not a token price.
  if (u.includes('tpm')) return null;
  if (!/token/.test(u)) return null;
  if (u.includes('1m') || u.includes('million')) return priceUsd;
  if (u.includes('1k') || u.includes('thousand')) return priceUsd * 1000;
  if (u === 'tokens' || u === 'token') return priceUsd * 1_000_000;
  return null;
}

interface OfferProductAttrs {
  model?: string;
  modelId?: string;
  /** First-party Titan rows carry the model name here, not in `model`. */
  titanModel?: string;
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

/**
 * On-demand standard tier: excludes batch, provisioned/reserved,
 * latency-optimized, priority and flex. Global and cache rows DO pass here —
 * they are separated afterwards, since we price them explicitly.
 */
function isStandardTier(attrs: OfferProductAttrs): boolean {
  const usage = attrs.usagetype ?? '';
  if (/Batch|LatencyOptimized|Reserved|ProvisionedThroughput/i.test(usage)) return false;
  if (/priority|flex/i.test(usage)) return false;
  if (attrs.feature && !/on-demand/i.test(attrs.feature) && attrs.feature !== '') return false;
  if (attrs.service_tier && /priority|flex/i.test(attrs.service_tier)) return false;
  return true;
}

/** Cross-region **global** inference profile SKU (billed below the regional rate). */
function isGlobalRow(attrs: OfferProductAttrs): boolean {
  return /Global|global[_-]standard/i.test(attrs.usagetype ?? '');
}

/**
 * Prompt-cache SKU. `CacheWrite1h` is a longer-TTL tier billed above the
 * default 5-minute write, so it is not folded into the standard cache rate.
 */
function cacheRowKind(attrs: OfferProductAttrs): 'read' | 'write' | 'other' | null {
  const usage = attrs.usagetype ?? '';
  if (!/Cache/i.test(usage)) return null;
  if (/CacheRead/i.test(usage)) return 'read';
  if (/CacheWrite1h/i.test(usage)) return 'other';
  if (/CacheWrite/i.test(usage)) return 'write';
  return 'other';
}

/**
 * Which side of the ledger a token row belongs to, independent of tier.
 * Output is checked first so `…OutputTokenCount…` can never fall through to an
 * input match.
 */
function tokenDirection(attrs: OfferProductAttrs): 'input' | 'output' | null {
  const inf = attrs.inferenceType ?? '';
  const usage = attrs.usagetype ?? '';
  if (/output\s*tokens?/i.test(inf)) return 'output';
  if (/input\s*tokens?/i.test(inf)) return 'input';
  if (/OutputTokenCount|ResponseTokenCount/i.test(usage)) return 'output';
  if (/InputTokenCount/i.test(usage)) return 'input';
  if (/output[_-]tokens/i.test(usage)) return 'output';
  if (/input[_-]tokens/i.test(usage)) return 'input';
  return null;
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

/**
 * Parse AWS offer JSON(s) into family-keyed rates (regional on-demand only).
 *
 * Resolution order per product:
 * 1. SDK-shaped id in `modelId` / `model` / embedded in `usagetype`
 * 2. Generative inference from marketplace display names (Claude / Titan / Nova shapes)
 * 3. Skip (unknown → no rate; use a pricing file in production)
 */
export function parseAwsOfferRates(offers: OfferJson[]): Map<string, BedrockModelRate> {
  const input = new Map<string, { perMTok: number; kind: BedrockModelRate['kind'] }>();
  const output = new Map<string, number>();
  const globalInput = new Map<string, number>();
  const globalOutput = new Map<string, number>();
  const cacheRead = new Map<string, number>();
  const cacheWrite = new Map<string, number>();

  /**
   * Lowest wins. Offer files can carry several standard-tier SKUs for one
   * family (context tiers, duplicated marketplace listings) and object key
   * order is not a meaningful tie-break — "first one seen" made the rate depend
   * on JSON ordering. The base tier is the conservative, reproducible choice.
   */
  function keepLowest(map: Map<string, number>, family: string, perMTok: number): void {
    const prev = map.get(family);
    if (prev == null || perMTok < prev) map.set(family, perMTok);
  }

  for (const offer of offers) {
    for (const [sku, product] of Object.entries(offer.products ?? {})) {
      const attrs = product.attributes ?? {};
      if (!isStandardTier(attrs)) continue;
      const mapped = resolveFamily(attrs);
      if (!mapped) continue;
      const price = extractOnDemandPrice(offer, sku);
      if (!price) continue;
      const perMTok = toPerMTok(price.usd, price.unit);
      if (perMTok == null) continue;

      const cache = cacheRowKind(attrs);
      if (cache) {
        // Cache rates are regional-only here; a global cache SKU would need its
        // own slot and no consumer asks for that yet.
        if (isGlobalRow(attrs)) continue;
        if (cache === 'read') keepLowest(cacheRead, mapped.family, perMTok);
        else if (cache === 'write') keepLowest(cacheWrite, mapped.family, perMTok);
        continue;
      }

      const direction = tokenDirection(attrs);
      if (!direction) continue;

      if (isGlobalRow(attrs)) {
        keepLowest(direction === 'input' ? globalInput : globalOutput, mapped.family, perMTok);
        continue;
      }

      if (direction === 'input') {
        const prev = input.get(mapped.family);
        if (prev == null || perMTok < prev.perMTok) {
          input.set(mapped.family, { perMTok, kind: mapped.kind });
        }
      } else {
        keepLowest(output, mapped.family, perMTok);
      }
    }
  }

  const rates = new Map<string, BedrockModelRate>();
  for (const [family, inp] of input) {
    const rate: BedrockModelRate = {
      inputPerMTok: inp.perMTok,
      outputPerMTok: output.get(family) ?? 0,
      kind: inp.kind,
    };
    const read = cacheRead.get(family);
    const write = cacheWrite.get(family);
    const gIn = globalInput.get(family);
    const gOut = globalOutput.get(family);
    if (read != null) rate.cacheReadPerMTok = read;
    if (write != null) rate.cacheWritePerMTok = write;
    if (gIn != null) rate.globalInputPerMTok = gIn;
    if (gOut != null) rate.globalOutputPerMTok = gOut;
    rates.set(family, rate);
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
    const parsedRate: BedrockModelRate = {
      inputPerMTok: rate.inputPerMTok,
      outputPerMTok: rate.outputPerMTok,
      kind: rate.kind,
    };
    // Optional refinements — omitted keys fall back to multipliers / regional.
    if (typeof rate.cacheReadPerMTok === 'number') {
      parsedRate.cacheReadPerMTok = rate.cacheReadPerMTok;
    }
    if (typeof rate.cacheWritePerMTok === 'number') {
      parsedRate.cacheWritePerMTok = rate.cacheWritePerMTok;
    }
    if (typeof rate.globalInputPerMTok === 'number') {
      parsedRate.globalInputPerMTok = rate.globalInputPerMTok;
    }
    if (typeof rate.globalOutputPerMTok === 'number') {
      parsedRate.globalOutputPerMTok = rate.globalOutputPerMTok;
    }
    rates.set(id, parsedRate);
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
  let failedAt = 0;
  let warmPromise: Promise<void> | null = null;
  let backgroundRefresh: Promise<void> | null = null;

  function lookup(modelId: string): BedrockModelRate | null {
    const exact = rates.get(modelId);
    if (exact) return exact;
    const family = normalizeBedrockModelId(modelId);
    const byFamily = rates.get(family);
    if (byFamily) return byFamily;
    // Display-name inference yields version-less keys (`amazon.nova-lite`) while
    // real ids normalize to versioned ones (`amazon.nova-lite-v1` from
    // `amazon.nova-lite-v1:0`). Try the version-less form last so keys that are
    // genuinely versioned (`amazon.titan-embed-text-v2`) still win above.
    const versionless = family.replace(/-v\d+$/i, '');
    if (versionless !== family) {
      return rates.get(versionless) ?? null;
    }
    return null;
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
      failedAt = Date.now();
      console.warn(
        `[plumbus/ai-bedrock] Could not download Price List for region ${options.region}; cost stays unknown until rates are available (retry in ${Math.round(FAILED_REFRESH_COOLDOWN_MS / 60_000)}m). Prefer AI_BEDROCK_PRICING_FILE in production.`,
      );
      return;
    }
    failedAt = 0;
    rates = parseAwsOfferRates(offers);
    loadedAt = Date.now();
    if (rates.size === 0) {
      console.warn(
        `[plumbus/ai-bedrock] Price List downloaded for ${options.region} but no regional on-demand rates could be keyed to Bedrock model ids. Mount AI_BEDROCK_PRICING_FILE with explicit family keys.`,
      );
    }
  }

  /** Refresh once in the background; callers keep serving the stale rates. */
  function refreshInBackground(): void {
    if (backgroundRefresh) return;
    backgroundRefresh = loadFromNetwork()
      .catch((err) => {
        failedAt = Date.now();
        console.warn(
          `[plumbus/ai-bedrock] Price List refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => {
        backgroundRefresh = null;
      });
  }

  async function warm(): Promise<void> {
    if (options.pricingFilePath) {
      if (rates.size > 0 && loadedAt > 0) return;
      await loadFromFile(options.pricingFilePath);
      return;
    }
    if (loadedAt === 0) {
      // Never loaded. Back off after a failure so a blocked pricing CDN does not
      // add the fetch timeout to every single inference request.
      if (failedAt > 0 && Date.now() - failedAt < FAILED_REFRESH_COOLDOWN_MS) return;
      await loadFromNetwork();
      return;
    }
    // Rates already in hand: refresh off the request path once the TTL expires.
    if (Date.now() - loadedAt > ttlMs) refreshInBackground();
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
      if (!rate) return undefined;

      // `global.` inference profiles are billed below the regional rate. Fall
      // back to regional when the file/offer has no global row.
      const isGlobalProfile = /^global\./i.test(modelId.trim());
      const inputPerMTok =
        (isGlobalProfile ? rate.globalInputPerMTok : undefined) ?? rate.inputPerMTok;
      const outputPerMTok =
        (isGlobalProfile ? rate.globalOutputPerMTok : undefined) ?? rate.outputPerMTok;

      const cached = usage.cachedInputTokens ?? 0;
      const cacheWrites = usage.cacheWriteTokens ?? 0;
      // Bedrock's `inputTokens` already EXCLUDES cache read/write tokens
      // ("total input tokens = inputTokens + cacheReadInputTokens +
      // cacheWriteInputTokens" — AWS prompt-caching docs), so they are billed
      // additively here, never subtracted out of `inputTokens`.
      const standardInput = Math.max(0, usage.inputTokens);
      // Published cache rates when known; otherwise approximate Anthropic-style
      // multipliers against the input rate.
      const cacheReadRate = rate.cacheReadPerMTok ?? inputPerMTok * 0.1;
      const cacheWriteRate = rate.cacheWritePerMTok ?? inputPerMTok * 1.25;
      const inputCost =
        standardInput * inputPerMTok + cached * cacheReadRate + cacheWrites * cacheWriteRate;
      const outputCost = usage.outputTokens * outputPerMTok;
      return Number(((inputCost + outputCost) / 1_000_000).toFixed(10));
    },
  };
}
