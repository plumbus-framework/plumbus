import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import type { ApiManifest, ApiManifestFinding } from './types.js';

function capabilityKey(cap: CapabilityContract): string {
  return `${cap.domain}.${cap.name}`;
}

function buildCapabilityMap(capabilities: CapabilityContract[]): Map<string, CapabilityContract> {
  const map = new Map<string, CapabilityContract>();
  for (const cap of capabilities) {
    map.set(capabilityKey(cap), cap);
  }
  return map;
}

export function validateManifest(
  manifest: ApiManifest,
  capabilities: CapabilityContract[],
): ApiManifestFinding[] {
  const findings: ApiManifestFinding[] = [];
  const capMap = buildCapabilityMap(capabilities);
  const operationIds = new Set<string>();
  const methodPaths = new Set<string>();

  for (const entry of manifest.expose) {
    const cap = capMap.get(entry.capability);
    if (cap === undefined) {
      findings.push({
        code: 'manifest.capability-not-found',
        message: `Capability "${entry.capability}" not found in registry`,
        capability: entry.capability,
        operationId: entry.operationId,
      });
      continue;
    }

    if (!isApiExposed(cap)) {
      findings.push({
        code: 'manifest.capability-not-exposed',
        message: `Capability "${entry.capability}" is not marked with exposeAs: ['api']`,
        capability: entry.capability,
        operationId: entry.operationId,
      });
    }

    if (operationIds.has(entry.operationId)) {
      findings.push({
        code: 'manifest.duplicate-operation-id',
        message: `Duplicate operationId "${entry.operationId}"`,
        operationId: entry.operationId,
        capability: entry.capability,
      });
    } else {
      operationIds.add(entry.operationId);
    }

    const methodPathKey = `${entry.method}:${entry.path}`;
    if (methodPaths.has(methodPathKey)) {
      findings.push({
        code: 'manifest.duplicate-method-path',
        message: `Duplicate method+path "${entry.method} ${entry.path}"`,
        operationId: entry.operationId,
        path: entry.path,
        capability: entry.capability,
      });
    } else {
      methodPaths.add(methodPathKey);
    }
  }

  return findings;
}
