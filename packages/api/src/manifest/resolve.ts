import { isApiExposed, type ApiExposureConfig, type CapabilityContract } from '@plumbus/core';
import { ApiManifestError } from '../errors.js';
import type { ApiManifestEntry } from './types.js';

export function resolveExposure(
  cap: CapabilityContract,
  manifestEntry?: ApiManifestEntry,
): ApiExposureConfig {
  if (!isApiExposed(cap)) {
    throw new ApiManifestError(
      `Capability "${cap.domain}.${cap.name}" is not exposed via API`,
      'api.resolve.not-exposed',
    );
  }

  const inline = cap.api;
  if (inline === undefined) {
    throw new ApiManifestError(
      `Capability "${cap.domain}.${cap.name}" has exposeAs: ['api'] but no inline api block`,
      'api.resolve.missing-inline',
    );
  }

  if (manifestEntry === undefined) {
    return inline;
  }

  return {
    ...inline,
    operationId: manifestEntry.operationId,
    method: manifestEntry.method,
    path: manifestEntry.path,
    stability: manifestEntry.stability ?? inline.stability,
    docs: manifestEntry.docs ?? inline.docs,
    deprecation: manifestEntry.deprecation ?? inline.deprecation,
    auth: manifestEntry.auth ?? inline.auth,
    idempotency: manifestEntry.idempotency ?? inline.idempotency,
    test: manifestEntry.test ?? inline.test,
  };
}
