import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import type { ApiManifest } from './types.js';

export function buildDefaultManifest(
  capabilities: CapabilityContract[],
  name = 'default-api',
): ApiManifest {
  const expose = capabilities
    .filter(isApiExposed)
    .map((cap) => {
      const api = cap.api;
      if (!api) {
        return null;
      }
      return {
        capability: `${cap.domain}.${cap.name}`,
        operationId: api.operationId,
        method: api.method,
        path: api.path,
        stability: api.stability,
        auth: api.auth,
        idempotency: api.idempotency,
        test: api.test,
        docs: api.docs,
        deprecation: api.deprecation,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return {
    apiVersion: 'plumbus.dev/v1',
    name,
    basePath: '/api/v1',
    expose,
  };
}
