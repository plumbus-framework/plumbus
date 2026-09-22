import { describe, expect, it } from 'vitest';
import type { ApiManifest } from '../../manifest/types.js';
import { collectExplicitTenantViolations } from '../tenant-boundary.js';

const manifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'test',
  basePath: '/api/v1',
  policy: {
    tenantRouting: { mode: 'auth-context', forbidExplicitTenantInput: true },
  },
  expose: [],
};

describe('collectExplicitTenantViolations', () => {
  it('flags tenantId in query', () => {
    const violations = collectExplicitTenantViolations(manifest, {}, { tenantId: 't1' });
    expect(violations).toContain('tenantId');
  });

  it('flags orgId in path params', () => {
    const violations = collectExplicitTenantViolations(manifest, { orgId: 'o1' }, {});
    expect(violations).toContain('orgId');
  });

  it('allows when policy disabled', () => {
    const open: ApiManifest = {
      ...manifest,
      policy: { tenantRouting: { mode: 'auth-context' } },
    };
    expect(collectExplicitTenantViolations(open, {}, { tenantId: 't1' })).toEqual([]);
  });
});
