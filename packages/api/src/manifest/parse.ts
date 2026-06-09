import { parse as parseYaml } from 'yaml';
import { ApiManifestError } from '../errors.js';
import { ApiManifestSchema } from './schema.js';
import type { ApiManifest } from './types.js';

export function parseManifest(source: string, format: 'yaml' | 'json'): ApiManifest {
  let parsed: unknown;
  try {
    parsed = format === 'yaml' ? parseYaml(source) : JSON.parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiManifestError(`Failed to parse manifest: ${message}`, 'api.manifest.parse-failed');
  }

  const result = ApiManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiManifestError(`Invalid manifest schema: ${issues}`, 'api.manifest.schema-invalid');
  }

  return result.data as ApiManifest;
}
