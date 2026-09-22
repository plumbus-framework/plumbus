import * as client from 'openid-client';
import { PROVIDER_MAX_REDIRECTS, PROVIDER_RESPONSE_MAX_BYTES } from '../config/constants.js';
import { resolveSecretSource, type SecretSource } from '../crypto/secret-source.js';
import type { NormalizedOidcProviderRegistration } from '../config/types.js';
import type { ProviderAvailabilityMap } from './availability.js';

export interface DiscoveredProvider {
  providerId: string;
  issuer: string;
  config: client.Configuration;
  metadata: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    jwksUri: string;
    userinfoEndpoint?: string;
    endSessionEndpoint?: string;
  };
}

interface DiscoveryCacheEntry {
  expiresAt: number;
  config: client.Configuration;
}

const discoveryCache = new Map<string, DiscoveryCacheEntry>();

function cacheKey(providerId: string, issuer: string): string {
  return `${providerId}:${issuer}`;
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<ArrayBuffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new ArrayBuffer(0);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error('provider response exceeds size limit');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged.buffer;
}

function createBoundedFetch(
  timeoutMs: number,
  environment: 'development' | 'production',
): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let currentUrl = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      let response = await fetch(currentUrl, {
        ...init,
        redirect: 'manual',
        signal: controller.signal,
      });
      let redirects = 0;
      while (response.status >= 300 && response.status < 400) {
        if (redirects >= PROVIDER_MAX_REDIRECTS) {
          throw new Error('provider redirect limit exceeded');
        }
        const location = response.headers.get('location');
        if (!location) break;
        const next = new URL(location, currentUrl);
        if (
          next.protocol !== 'https:' &&
          !(environment === 'development' && next.hostname === '127.0.0.1')
        ) {
          throw new Error('provider redirect must remain HTTPS');
        }
        if (next.origin !== currentUrl.origin) {
          throw new Error('provider redirect must remain same-origin');
        }
        currentUrl = next;
        response = await fetch(currentUrl, {
          ...init,
          redirect: 'manual',
          signal: controller.signal,
        });
        redirects += 1;
      }
      if (response.body) {
        const body = await readLimitedBody(response, PROVIDER_RESPONSE_MAX_BYTES);
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function discoverProvider(
  providerId: string,
  registration: NormalizedOidcProviderRegistration,
  opts: {
    environment: 'development' | 'production';
    fetchTimeoutMs: number;
    clientSecret: string;
    availability: ProviderAvailabilityMap;
  },
): Promise<DiscoveredProvider | null> {
  const key = cacheKey(providerId, registration.issuer);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return buildDiscovered(providerId, registration.issuer, cached.config);
  }

  try {
    const customFetch = createBoundedFetch(opts.fetchTimeoutMs, opts.environment);
    const discoveryOptions: Record<string, unknown> = { [client.customFetch]: customFetch };
    if (opts.environment === 'development') {
      discoveryOptions.execute = [client.allowInsecureRequests];
    }
    const config = await client.discovery(
      new URL(registration.issuer),
      registration.clientId,
      { client_secret: opts.clientSecret },
      client.ClientSecretPost(opts.clientSecret),
      discoveryOptions,
    );
    const serverMetadata = config.serverMetadata();
    if (serverMetadata.issuer !== registration.issuer) {
      throw new Error('issuer mismatch');
    }
    discoveryCache.set(key, {
      config,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });
    opts.availability.set(providerId, 'available');
    return buildDiscovered(providerId, registration.issuer, config);
  } catch {
    opts.availability.set(providerId, 'unavailable');
    scheduleRetry(providerId, registration, opts);
    return null;
  }
}

function buildDiscovered(
  providerId: string,
  issuer: string,
  config: client.Configuration,
): DiscoveredProvider {
  const metadata = config.serverMetadata();
  return {
    providerId,
    issuer,
    config,
    metadata: {
      authorizationEndpoint: metadata.authorization_endpoint ?? '',
      tokenEndpoint: metadata.token_endpoint ?? '',
      jwksUri: metadata.jwks_uri ?? '',
      userinfoEndpoint: metadata.userinfo_endpoint,
      endSessionEndpoint: metadata.end_session_endpoint,
    },
  };
}

const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRetry(
  providerId: string,
  registration: NormalizedOidcProviderRegistration,
  opts: {
    environment: 'development' | 'production';
    fetchTimeoutMs: number;
    clientSecret: string;
    availability: ProviderAvailabilityMap;
  },
): void {
  if (retryTimers.has(providerId)) return;
  const delay = 1000 + Math.floor(Math.random() * 1000);
  const timer = setTimeout(() => {
    retryTimers.delete(providerId);
    void discoverProvider(providerId, registration, opts);
  }, delay);
  timer.unref?.();
  retryTimers.set(providerId, timer);
}

export function clearDiscoveryRetries(): void {
  for (const timer of retryTimers.values()) {
    clearTimeout(timer);
  }
  retryTimers.clear();
}

export async function resolveClientSecret(source: SecretSource): Promise<string> {
  const value = await resolveSecretSource(source);
  if (!value) {
    throw new Error('client secret is empty');
  }
  return value;
}
