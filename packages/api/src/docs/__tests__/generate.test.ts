import { defineCapability } from '@plumbus/core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import type { ApiManifest } from '../../manifest/types.js';
import { generateApiDocs } from '../generate.js';

const manifest: ApiManifest = {
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
};

describe('generateApiDocs', () => {
  it('docs emit one file per operation', () => {
    const cap = defineCapability({
      name: 'getRefund',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'getRefund',
        method: 'GET',
        path: '/refunds/{refundId}',
        docs: { summary: 'Get refund' },
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId }),
    });

    const files = generateApiDocs([cap], manifest);
    expect(files.has('overview.md')).toBe(true);
    expect(files.has('authentication.md')).toBe(true);
    expect(files.has('endpoints/getRefund.md')).toBe(true);
    expect(files.get('endpoints/getRefund.md')).toContain('Get refund');
  });

  it('defaults idempotency header name in docs when omitted', () => {
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'approved' }),
    });

    const files = generateApiDocs([cap], {
      ...manifest,
      expose: [
        {
          capability: 'billing.approveRefund',
          operationId: 'approveRefund',
          method: 'POST',
          path: '/refunds/{refundId}/approve',
          idempotency: { required: true } as { required: boolean; header?: string },
        },
      ],
    });

    const doc = files.get('endpoints/approveRefund.md');
    expect(doc).toContain('`Idempotency-Key`');
    expect(doc).not.toContain('`undefined`');
  });
});
