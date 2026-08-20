import { defineCapability } from '@plumbus/core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { diffOpenApi } from '../diff.js';
import { generateOpenApi } from '../../openapi/generate.js';
import type { ApiManifest } from '../../manifest/types.js';

// Diff the generator's own 3.0.3 and 3.1.0 output for the *same* capabilities. Everything the
// dialect conversion touches — nullable primitives, nullable objects, nullable enums, numeric
// bounds, examples — has to survive the round trip as "no schema change".

function refundCapabilities() {
  return [
    defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      description: 'Get refund',
      input: z.object({ refundId: z.string(), includeLineItems: z.boolean().optional() }),
      output: z.object({
        refundId: z.string(),
        status: z.enum(['open', 'settled']),
        note: z.string().nullable(),
        amount: z.number().min(0).max(1_000_000),
        settledAt: z.string().datetime().nullable(),
        lineItems: z.array(z.object({ sku: z.string(), quantity: z.number().int() })),
        counterparty: z.object({ id: z.string(), label: z.string() }).nullable(),
        tier: z.enum(['standard', 'priority']).nullable(),
      }),
      effects: { data: ['Refund'], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'getRefund',
        method: 'GET',
        path: '/refunds/{refundId}',
        auth: { scopes: ['refunds:read'] },
      },
      handler: async (_ctx, input) => ({
        refundId: input.refundId,
        status: 'open' as const,
        note: null,
        amount: 0,
        settledAt: null,
        lineItems: [],
        counterparty: null,
        tier: null,
      }),
    }),
    defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      description: 'Approve refund',
      input: z.object({
        refundId: z.string(),
        reason: z.string(),
        note: z.string().nullable().optional(),
      }),
      output: z.object({ refundId: z.string(), approved: z.boolean() }),
      effects: { data: ['Refund'], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
        auth: { scopes: ['refunds:write'] },
        idempotency: { required: true, header: 'Idempotency-Key' },
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId, approved: true }),
    }),
  ];
}

const manifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'partner-api',
  basePath: '/api/v1',
  identity: { defaultSecurityScheme: 'partnerOAuth', audience: 'partners' },
  securitySchemes: {
    partnerOAuth: {
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: 'https://identity.example.com/oauth2/token',
          scopes: { 'refunds:read': 'Read refunds', 'refunds:write': 'Write refunds' },
        },
      },
    },
  },
  expose: [
    {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
      auth: { scopes: ['refunds:read'] },
    },
    {
      capability: 'billing.approveRefund',
      operationId: 'approveRefund',
      method: 'POST',
      path: '/refunds/{refundId}/approve',
      auth: { scopes: ['refunds:write'] },
    },
  ],
};

describe('diffOpenApi over generated 3.0.3 and 3.1.0 documents', () => {
  const caps = refundCapabilities();
  const doc30 = generateOpenApi(caps, manifest);
  const doc31 = generateOpenApi(caps, manifest, { version: '3.1.0' });

  it('generates the two document versions from one set of capabilities', () => {
    expect(doc30.openapi).toBe('3.0.3');
    expect(doc31.openapi).toBe('3.1.0');
  });

  it('reports the upgrade as one non-breaking version change and nothing else', () => {
    const diff = diffOpenApi(doc30, doc31);

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking.map((e) => e.kind)).toEqual(['changed-openapi-version']);
  });

  it('reports the downgrade the same way', () => {
    const diff = diffOpenApi(doc31, doc30);

    expect(diff.breaking).toEqual([]);
    expect(diff.nonBreaking.map((e) => e.kind)).toEqual(['changed-openapi-version']);
  });

  it('still catches a removed response field between dialects', () => {
    const shrunk = refundCapabilities();
    const [getRefund] = shrunk;
    if (!getRefund) {
      throw new Error('expected the getRefund capability');
    }
    const trimmed = {
      ...getRefund,
      output: z.object({
        refundId: z.string(),
        status: z.enum(['open', 'settled']),
        amount: z.number().min(0).max(1_000_000),
      }),
    } as typeof getRefund;

    const diff = diffOpenApi(doc30, generateOpenApi([trimmed], manifest, { version: '3.1.0' }));

    expect(diff.breaking.map((e) => e.kind)).toContain('removed-response-field');
  });
});
