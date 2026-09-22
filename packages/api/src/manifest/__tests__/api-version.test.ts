import { describe, expect, it } from 'vitest';
import { apiVersionFromManifest, joinApiPath } from '../api-version.js';
import type { ApiManifest } from '../types.js';

const manifest = (basePath: string): ApiManifest => ({
  apiVersion: 'plumbus.dev/v1',
  name: 'test',
  basePath,
  expose: [],
});

describe('apiVersionFromManifest', () => {
  it('extracts version from basePath', () => {
    expect(apiVersionFromManifest(manifest('/api/v2'))).toBe('v2');
    expect(apiVersionFromManifest(manifest('/api/v1'))).toBe('v1');
  });

  it('defaults to v1 when no version segment', () => {
    expect(apiVersionFromManifest(manifest('/partner'))).toBe('v1');
  });
});

describe('joinApiPath', () => {
  it('joins without collapsing internal slashes', () => {
    expect(joinApiPath('/api/v1', '/refunds')).toBe('/api/v1/refunds');
    expect(joinApiPath('/api/v1/', '/refunds')).toBe('/api/v1/refunds');
  });

  it('requires basePath to start with slash', () => {
    expect(() => joinApiPath('api/v1', '/refunds')).toThrow(/must start with/);
  });
});
