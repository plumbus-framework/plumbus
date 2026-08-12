/**
 * Configuration for {@link createBedrockAdapter}.
 *
 * Pricing:
 * - Set `pricingFilePath` to load a normalized JSON file (recommended for
 *   containers / Kubernetes — no egress to the AWS Price List CDN).
 * - Otherwise rates are auto-downloaded for `region` and cached in memory.
 */
export interface BedrockAdapterConfig {
  /** AWS region for Bedrock Runtime and Price List lookup (e.g. `us-east-1`). */
  region: string;
  /**
   * Optional credentials. When omitted, the AWS default credential provider
   * chain is used (env keys, shared config, IRSA, instance role, …).
   */
  credentials?:
    | import('@aws-sdk/types').AwsCredentialIdentity
    | import('@aws-sdk/types').AwsCredentialIdentityProvider;
  /** Default Converse model id when a request omits `model`. */
  defaultModel?: string;
  /** Default embedding model id (default: Titan Text Embeddings V2). */
  defaultEmbeddingModel?: string;
  /** Request timeout in milliseconds (default: 120_000). */
  requestTimeout?: number;
  /**
   * Provider-side structured outputs via Converse `outputConfig.textFormat`.
   *
   * - `'off'` (default) — schemas are enforced by core's validate-and-repair
   *   loop, exactly as before. Safe on every model.
   * - `'native'` — forward `responseSchema` to Bedrock. Support is
   *   model-dependent; a model that does not accept `outputConfig` rejects the
   *   whole request, so enable it per deployment once you have verified your
   *   model supports it.
   */
  structuredOutputs?: 'off' | 'native';
  /**
   * Max concurrent InvokeModel embedding calls (default: 4). Titan embeds one
   * text per request, so this bounds the fan-out for a corpus ingest.
   */
  embedConcurrency?: number;
  /**
   * `input_type` sent to Cohere embedding models (default: `search_document`).
   * Ignored by Titan. Use `search_query` for query-side embeddings if you keep
   * a separate adapter for retrieval.
   */
  embeddingInputType?: string;
  /** Optional Bedrock Runtime endpoint override (VPC / GovCloud). */
  endpoint?: string;
  /**
   * Path to a normalized pricing JSON file. When set, rates load from this
   * file and auto-download is skipped. Recommended for container deployments.
   */
  pricingFilePath?: string;
  /**
   * TTL for auto-downloaded rates in memory (ignored when `pricingFilePath`
   * is set). Default: 24 hours.
   */
  pricingCacheTtlMs?: number;
  /**
   * When true (default), warm pricing during the first AI call (file load or
   * auto-download). File mode fails clearly if the path is missing/invalid;
   * auto-download failures warn and leave rates empty (cost $0).
   */
  warmPricingOnCreate?: boolean;
  /** Timeout for auto-download warm/refresh (default: 15_000). */
  pricingRefreshTimeoutMs?: number;
  /**
   * Optional BedrockRuntimeClient override (tests). When omitted a client is
   * constructed from region / credentials / endpoint.
   */
  runtimeClient?: import('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient;
  /** Optional pricing store override (tests). */
  pricingStore?: import('./pricing.js').BedrockPricingStore;
}

/** Default Titan Text Embeddings V2 model id. */
export const BEDROCK_DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';

/**
 * Normalized pricing file schema (version 1).
 *
 * Operators generate this in CI from the AWS Price List and mount it
 * (ConfigMap / volume). Keys should be Bedrock model ids (or family keys
 * such as `anthropic.claude-haiku-4-5`).
 */
export interface BedrockPricingFileV1 {
  version: 1;
  /** ISO region the rates apply to (informational). */
  region?: string;
  /** Optional ISO timestamp when the file was generated. */
  generatedAt?: string;
  models: Record<string, BedrockModelRate>;
}

export interface BedrockModelRate {
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens (0 for embeddings). */
  outputPerMTok: number;
  kind?: 'text' | 'embedding' | 'moderation' | 'image' | 'audio';
  /**
   * USD per 1M cache-read input tokens. When absent, cost falls back to an
   * approximate 0.1× of `inputPerMTok`.
   */
  cacheReadPerMTok?: number;
  /**
   * USD per 1M cache-write input tokens (default 5-minute TTL). When absent,
   * cost falls back to an approximate 1.25× of `inputPerMTok`. Longer TTLs are
   * billed higher by AWS and are not modelled — mount explicit rates if you
   * rely on 1-hour caching.
   */
  cacheWritePerMTok?: number;
  /**
   * USD per 1M tokens when called through a **global** cross-region inference
   * profile (`global.` prefix), which AWS bills below the regional rate. When
   * absent, `global.` ids fall back to the regional rate.
   */
  globalInputPerMTok?: number;
  /** USD per 1M output tokens for global inference profiles. */
  globalOutputPerMTok?: number;
}
