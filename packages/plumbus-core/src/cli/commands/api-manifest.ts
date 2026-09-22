import { readFile } from 'node:fs/promises';
import type { CapabilityContract } from '../../types/capability.js';

export interface ApiManifestLoader {
  parseManifest: (source: string, format: 'yaml' | 'json') => unknown;
  buildDefaultManifest: (capabilities: CapabilityContract[]) => unknown;
}

export class ApiManifestLoadError extends Error {
  readonly filePath: string;
  readonly reason: 'not-found' | 'invalid';

  constructor(filePath: string, reason: 'not-found' | 'invalid', message: string) {
    super(message);
    this.name = 'ApiManifestLoadError';
    this.filePath = filePath;
    this.reason = reason;
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

/**
 * Load an API manifest from disk. Falls back to inline defaults only when the
 * default manifest path is missing (ENOENT). Explicit --manifest paths and
 * parse/schema failures always surface as errors.
 */
export async function resolveApiManifest(opts: {
  filePath: string;
  explicitManifest: boolean;
  capabilities: CapabilityContract[];
  api: ApiManifestLoader;
  readFileFn?: (path: string) => Promise<string>;
}): Promise<{ manifest: unknown; warning?: string }> {
  const format = opts.filePath.endsWith('.json') ? 'json' : 'yaml';

  try {
    const source = opts.readFileFn
      ? await opts.readFileFn(opts.filePath)
      : await readFile(opts.filePath, 'utf8');
    try {
      return { manifest: opts.api.parseManifest(source, format) };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new ApiManifestLoadError(
        opts.filePath,
        'invalid',
        `Failed to parse API manifest at ${opts.filePath}: ${detail}`,
      );
    }
  } catch (err) {
    if (err instanceof ApiManifestLoadError) {
      throw err;
    }
    if (isENOENT(err)) {
      if (opts.explicitManifest) {
        throw new ApiManifestLoadError(
          opts.filePath,
          'not-found',
          `API manifest not found: ${opts.filePath}`,
        );
      }
      return {
        manifest: opts.api.buildDefaultManifest(opts.capabilities),
        warning: `No manifest at ${opts.filePath} — using inline api metadata only`,
      };
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiManifestLoadError(
      opts.filePath,
      'invalid',
      `Failed to read API manifest at ${opts.filePath}: ${detail}`,
    );
  }
}
