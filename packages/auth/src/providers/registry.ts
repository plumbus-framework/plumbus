import type { NormalizedOidcProviderRegistration } from '../config/types.js';
import { RESERVED_AUTH_PARAMS } from '../config/constants.js';
import type { OidcProviderIntegration } from './integration.js';

export interface ProviderRegistryEntry extends NormalizedOidcProviderRegistration {
  id: string;
  integration?: OidcProviderIntegration;
}

export function createProviderRegistry(
  providers: Record<string, NormalizedOidcProviderRegistration>,
): Map<string, ProviderRegistryEntry> {
  const registry = new Map<string, ProviderRegistryEntry>();
  for (const [id, registration] of Object.entries(providers)) {
    registry.set(id, {
      ...registration,
      id,
      integration: registration.integration
        ? Object.freeze({ ...registration.integration, id: registration.integration.id ?? id })
        : undefined,
    });
  }
  return registry;
}

export function validateProviderParams(
  integration: OidcProviderIntegration | undefined,
  options: Readonly<Record<string, string>>,
): { ok: true; params: Readonly<Record<string, string>> } | { ok: false; reason: string } {
  for (const key of Object.keys(options)) {
    if ((RESERVED_AUTH_PARAMS as readonly string[]).includes(key)) {
      return { ok: false, reason: `reserved parameter: ${key}` };
    }
  }
  if (!integration?.authorizationParams) {
    if (Object.keys(options).length > 0) {
      return { ok: false, reason: 'provider does not accept custom parameters' };
    }
    return { ok: true, params: {} };
  }
  const result = integration.authorizationParams(options);
  if (!result.ok) {
    return result;
  }
  for (const key of Object.keys(result.params)) {
    if ((RESERVED_AUTH_PARAMS as readonly string[]).includes(key)) {
      return { ok: false, reason: `integration returned reserved parameter: ${key}` };
    }
  }
  return result;
}
