import { defineCapability } from '@plumbus/core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { parseManifest } from '../parse.js';
import { resolveExposure } from '../resolve.js';
import { validateManifest } from '../validate-against-registry.js';

const yamlManifest = `
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1
expose:
  - capability: billing.getRefund
    operationId: getRefund
    method: GET
    path: /refunds/{refundId}
`;

const jsonManifest = JSON.stringify({
  apiVersion: 'plumbus.dev/v1',
  name: 'partner-api',
  basePath: '/api/v1',
  expose: [
    {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
    },
  ],
});

function apiCap(overrides: Record<string, unknown> = {}) {
  return defineCapability({
    name: 'getRefund',
    kind: 'query',
    domain: 'billing',
    input: z.object({ refundId: z.string() }),
    output: z.object({ refundId: z.string(), status: z.string() }),
    effects: { data: ['Refund'], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: {
      operationId: 'getRefundInline',
      method: 'GET',
      path: '/inline/refunds/{refundId}',
      docs: { summary: 'Inline summary' },
    },
    handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'pending' }),
    ...overrides,
  });
}

describe('parseManifest', () => {
  it('parses yaml manifest', () => {
    const m = parseManifest(yamlManifest, 'yaml');
    expect(m.name).toBe('partner-api');
    expect(m.expose).toHaveLength(1);
    expect(m.expose[0]?.operationId).toBe('getRefund');
  });

  it('parses json manifest', () => {
    const m = parseManifest(jsonManifest, 'json');
    expect(m.basePath).toBe('/api/v1');
  });

  it('rejects malformed manifest', () => {
    expect(() => parseManifest('not: [valid', 'yaml')).toThrow();
    expect(() => parseManifest('{}', 'json')).toThrow();
  });
});

describe('validateManifest', () => {
  it('flags capability not found', () => {
    const manifest = parseManifest(yamlManifest, 'yaml');
    const findings = validateManifest(manifest, []);
    expect(findings.some((f) => f.code === 'manifest.capability-not-found')).toBe(true);
  });

  it('flags capability not exposed via api', () => {
    const cap = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async (_ctx, input) => ({ refundId: input.refundId }),
    });
    const manifest = parseManifest(yamlManifest, 'yaml');
    const findings = validateManifest(manifest, [cap]);
    expect(findings.some((f) => f.code === 'manifest.capability-not-exposed')).toBe(true);
  });

  it('flags duplicate operationId', () => {
    const cap = apiCap();
    const manifest = parseManifest(
      `
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1
expose:
  - capability: billing.getRefund
    operationId: dup
    method: GET
    path: /a
  - capability: billing.getRefund
    operationId: dup
    method: POST
    path: /b
`,
      'yaml',
    );
    const findings = validateManifest(manifest, [cap]);
    expect(findings.some((f) => f.code === 'manifest.duplicate-operation-id')).toBe(true);
  });

  it('flags duplicate method+path', () => {
    const cap = apiCap();
    const manifest = parseManifest(
      `
apiVersion: plumbus.dev/v1
name: partner-api
basePath: /api/v1
expose:
  - capability: billing.getRefund
    operationId: op1
    method: GET
    path: /same
  - capability: billing.getRefund
    operationId: op2
    method: GET
    path: /same
`,
      'yaml',
    );
    const findings = validateManifest(manifest, [cap]);
    expect(findings.some((f) => f.code === 'manifest.duplicate-method-path')).toBe(true);
  });
});

describe('resolveExposure', () => {
  it('manifest entry overrides inline path/docs', () => {
    const cap = apiCap();
    const entry = {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET' as const,
      path: '/refunds/{refundId}',
      docs: { summary: 'Manifest summary' },
    };
    const resolved = resolveExposure(cap, entry);
    expect(resolved.path).toBe('/refunds/{refundId}');
    expect(resolved.docs?.summary).toBe('Manifest summary');
    expect(resolved.operationId).toBe('getRefund');
  });

  it('resolver never exposes non-api capability', () => {
    const cap = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async (_ctx, input) => ({ refundId: input.refundId }),
    });
    expect(() => resolveExposure(cap)).toThrow('not exposed via API');
  });
});
