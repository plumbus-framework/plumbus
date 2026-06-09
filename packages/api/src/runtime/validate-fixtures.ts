import { readFile } from 'node:fs/promises';
import { isApiExposed, type CapabilityContract } from '@plumbus/core';
import type { ApiManifest, ApiManifestFinding } from '../manifest/types.js';
import { resolveExposure } from '../manifest/resolve.js';
import { FixturePathEscapeError, resolveContainedFixturePath } from './fixture-path.js';

function findManifestEntry(manifest: ApiManifest, cap: CapabilityContract) {
  const key = `${cap.domain}.${cap.name}`;
  return manifest.expose.find((e) => e.capability === key);
}

export async function validateTestFixtures(
  capabilities: CapabilityContract[],
  appRoot: string,
  manifest?: ApiManifest,
): Promise<ApiManifestFinding[]> {
  const findings: ApiManifestFinding[] = [];

  for (const cap of capabilities) {
    if (!isApiExposed(cap)) {
      continue;
    }

    const entry = manifest ? findManifestEntry(manifest, cap) : undefined;
    const resolved = manifest ? resolveExposure(cap, entry) : cap.api;
    const fixture = resolved?.test?.safeReply?.fixture;
    if (!fixture) {
      continue;
    }

    const operationId = resolved?.operationId ?? cap.api?.operationId;
    const capabilityKey = `${cap.domain}.${cap.name}`;

    let resolvedPath: string;
    try {
      resolvedPath = resolveContainedFixturePath(appRoot, fixture);
    } catch (err) {
      const message =
        err instanceof FixturePathEscapeError ? err.message : 'Fixture path is not allowed';
      findings.push({
        code: 'test.fixture-path-escape',
        message: `${message} for ${capabilityKey}`,
        capability: capabilityKey,
        operationId,
      });
      continue;
    }

    try {
      const raw = await readFile(resolvedPath, 'utf8');
      const data = JSON.parse(raw) as unknown;
      const parsed = cap.output.safeParse(data);
      if (!parsed.success) {
        findings.push({
          code: 'test.fixture-schema-mismatch',
          message: `Safe-reply fixture does not match output schema for ${capabilityKey}`,
          capability: capabilityKey,
          operationId,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      findings.push({
        code: 'test.fixture-read-failed',
        message: `Could not read safe-reply fixture for ${capabilityKey}: ${message}`,
        capability: capabilityKey,
        operationId,
      });
    }
  }

  return findings;
}
