import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../../define/defineCapability.js';
import { ApiManifestLoadError, resolveApiManifest } from '../api-manifest.js';

const capabilities = [
  defineCapability({
    name: 'getRefund',
    kind: 'query',
    domain: 'billing',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: { operationId: 'getRefund', method: 'GET', path: '/refunds/{id}' },
    handler: async (_ctx, input) => ({ id: input.id }),
  }),
];

const apiLoader = {
  parseManifest: (source: string) => {
    if (source.includes('INVALID')) {
      throw new Error('schema validation failed');
    }
    return {
      apiVersion: 'plumbus.dev/v1',
      name: 'from-file',
      basePath: '/api/v1',
      expose: [],
    };
  },
  buildDefaultManifest: () => ({
    apiVersion: 'plumbus.dev/v1',
    name: 'inline-default',
    basePath: '/api/v1',
    expose: [],
  }),
};

describe('resolveApiManifest', () => {
  it('falls back to default manifest only when default path is missing', async () => {
    const result = await resolveApiManifest({
      filePath: '/app/api.yaml',
      explicitManifest: false,
      capabilities,
      api: apiLoader,
      readFileFn: async () => {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
    });
    expect(result.warning).toContain('No manifest at');
    expect(result.manifest).toEqual(expect.objectContaining({ name: 'inline-default' }));
  });

  it('fails when explicit --manifest path is missing', async () => {
    await expect(
      resolveApiManifest({
        filePath: '/missing/api.yaml',
        explicitManifest: true,
        capabilities,
        api: apiLoader,
        readFileFn: async () => {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        },
      }),
    ).rejects.toBeInstanceOf(ApiManifestLoadError);
  });

  it('fails when manifest file exists but parse fails', async () => {
    await expect(
      resolveApiManifest({
        filePath: '/app/api.yaml',
        explicitManifest: false,
        capabilities,
        api: apiLoader,
        readFileFn: async () => 'INVALID yaml',
      }),
    ).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('parses a valid manifest file', async () => {
    const result = await resolveApiManifest({
      filePath: '/app/api.yaml',
      explicitManifest: false,
      capabilities,
      api: apiLoader,
      readFileFn: async () => 'valid: true',
    });
    expect(result.manifest).toEqual(expect.objectContaining({ name: 'from-file' }));
    expect(result.warning).toBeUndefined();
  });
});
