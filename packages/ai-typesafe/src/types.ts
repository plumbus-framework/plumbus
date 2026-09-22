import type { ModelCard, RetryPolicy, TypeSafeClient } from '@typesafe-ai/sdk';

/**
 * Configuration shared by {@link createTypeSafeDecisionAdapter} and
 * {@link createTypeSafeAdapter}.
 *
 * Both adapters talk to the same endpoint with the same credentials, so an app
 * that wants `ctx.ai.decide()` and a Jev-backed `ctx.ai.classify()` configures
 * one slot and gets both.
 */
export interface TypeSafeAdapterConfig {
  /** API key. Falls back to `TYPESAFE_API_KEY` when omitted. */
  apiKey?: string;
  /** Model or alias used when a request omits one (SDK default: `jev-latest`). */
  defaultModel?: string;
  /** API root. Falls back to `TYPESAFE_BASE_URL`, then `https://api.typesafe.ai`. */
  baseUrl?: string;
  /**
   * Timeout per attempt in milliseconds. The SDK applies this per attempt
   * rather than as a total retry budget (SDK default: 10_000).
   */
  requestTimeout?: number;
  /**
   * Retry overrides. Omitted fields keep the SDK defaults, which already back
   * off on 408/429/5xx and honor `retry-after`, so the framework does not need
   * its own retry layer on top.
   */
  retry?: Partial<RetryPolicy>;
  /**
   * Pre-built client, for tests and for apps that need custom transport. When
   * set, every other connection field is ignored.
   */
  client?: TypeSafeClient;
}

/** Config for the classify-only {@link createTypeSafeAdapter}. */
export interface TypeSafeClassifyAdapterConfig extends TypeSafeAdapterConfig {
  /**
   * Minimum probability for a label to be returned by `ctx.ai.classify()`
   * (default: 0.5).
   *
   * `classify()` is multi-label, so the adapter asks one yes/no question per
   * label in a single request and keeps the labels above this threshold. Raise
   * it for precision, lower it for recall. When you need the underlying
   * probabilities rather than a filtered list, use `ctx.ai.decide()`.
   */
  labelThreshold?: number;
}

/** A model entry from `GET /v1/models`, as returned by the SDK. */
export type TypeSafeModelCard = ModelCard;
