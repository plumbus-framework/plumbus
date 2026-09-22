import { TypeSafeClient } from '@typesafe-ai/sdk';
import type { TypeSafeAdapterConfig } from './types.js';

/**
 * Build (or accept) the SDK client both adapters share.
 *
 * The SDK owns retries and `retry-after` handling, so the framework passes
 * timeouts and retry overrides straight through instead of wrapping them.
 */
export function resolveClient(config: TypeSafeAdapterConfig): TypeSafeClient {
  if (config.client) return config.client;

  return new TypeSafeClient({
    ...(config.apiKey != null ? { apiKey: config.apiKey } : {}),
    ...(config.baseUrl != null ? { baseURL: config.baseUrl } : {}),
    ...(config.defaultModel != null ? { defaultModel: config.defaultModel } : {}),
    ...(config.requestTimeout != null ? { timeout: config.requestTimeout } : {}),
    ...(config.retry != null ? { retry: config.retry } : {}),
  });
}
