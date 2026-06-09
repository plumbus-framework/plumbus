import { defineCapability } from '@plumbus/core';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { mapCoreError } from '../../runtime/envelope.js';
import { generateOpenApi } from '../generate.js';
import type { ApiManifest } from '../../manifest/types.js';

function apiCap() {
  return defineCapability({
    name: 'getRefund',
    kind: 'query',
    domain: 'billing',
    description: 'Get refund',
    input: z.object({ refundId: z.string() }),
    output: z.object({ refundId: z.string(), status: z.string() }),
    effects: { data: ['Refund'], events: [], external: [], ai: false },
    exposeAs: ['api'],
    api: {
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
      stability: 'deprecated',
      auth: { scopes: ['refunds:read'] },
    },
    handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'ok' }),
  });
}

const manifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'partner-api',
  basePath: '/api/v1',
  identity: { defaultAuth: 'oauth2', audience: 'partners' },
  expose: [
    {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
      auth: { scopes: ['refunds:read'] },
    },
  ],
};

describe('generateOpenApi', () => {
  it('emits per-field path parameters for GET', () => {
    const doc = generateOpenApi([apiCap()], manifest);
    const path = doc.paths['/refunds/{refundId}'];
    expect(path).toBeDefined();
    const getOp = path?.get as Record<string, unknown>;
    expect(getOp).toBeDefined();
    const params = getOp.parameters as {
      in: string;
      name: string;
      schema: Record<string, unknown>;
    }[];
    const refundParam = params.find((p) => p.name === 'refundId');
    expect(refundParam?.in).toBe('path');
    expect(refundParam?.schema).toHaveProperty('type', 'string');
  });

  it('emits per-field query parameters for GET list operations', () => {
    const listCap = defineCapability({
      name: 'listRefunds',
      kind: 'query',
      domain: 'billing',
      input: z.object({ limit: z.number(), status: z.string().optional() }),
      output: z.object({ items: z.array(z.string()) }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'listRefunds', method: 'GET', path: '/refunds' },
      handler: async () => ({ items: [] }),
    });
    const listManifest: ApiManifest = {
      ...manifest,
      expose: [
        {
          capability: 'billing.listRefunds',
          operationId: 'listRefunds',
          method: 'GET',
          path: '/refunds',
        },
      ],
    };
    const doc = generateOpenApi([listCap], listManifest);
    const getOp = doc.paths['/refunds']?.get as {
      parameters?: { in: string; name: string }[];
    };
    const names = getOp.parameters?.map((p) => `${p.in}:${p.name}`) ?? [];
    expect(names).toContain('query:limit');
    expect(names).toContain('query:status');
  });

  it('omits non-api capabilities', () => {
    const internal = defineCapability({
      name: 'internal',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });
    const doc = generateOpenApi([apiCap(), internal], manifest);
    expect(Object.keys(doc.paths)).toHaveLength(1);
  });

  it('includes security scopes and declares oauth2 scheme', () => {
    const doc = generateOpenApi([apiCap()], manifest);
    const getOp = doc.paths['/refunds/{refundId}']?.get as {
      security?: { oauth2: string[] }[];
    };
    expect(getOp.security?.[0]?.oauth2).toContain('refunds:read');
    const schemes = doc.components?.securitySchemes as Record<
      string,
      { flows?: { clientCredentials?: { scopes?: Record<string, string> } } }
    >;
    expect(schemes.oauth2).toBeDefined();
    expect(schemes.oauth2?.flows?.clientCredentials?.scopes?.['refunds:read']).toBe('refunds:read');
  });

  it('warns on duplicate method+path', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dupCap = defineCapability({
      name: 'getRefundDup',
      kind: 'query',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ refundId: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'getRefundDup', method: 'GET', path: '/refunds/{refundId}' },
      handler: async (_ctx, input) => ({ refundId: input.refundId }),
    });
    const dupManifest: ApiManifest = {
      ...manifest,
      expose: [
        ...manifest.expose,
        {
          capability: 'billing.getRefundDup',
          operationId: 'getRefundDup',
          method: 'GET',
          path: '/refunds/{refundId}',
        },
      ],
    };
    generateOpenApi([apiCap(), dupCap], dupManifest);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('marks deprecated operations', () => {
    const doc = generateOpenApi([apiCap()], manifest);
    const getOp = doc.paths['/refunds/{refundId}']?.get as { deprecated?: boolean };
    expect(getOp.deprecated).toBe(true);
  });

  it('error envelope component present', () => {
    const doc = generateOpenApi([apiCap()], manifest);
    const schemas = doc.components?.schemas as Record<string, unknown>;
    expect(schemas.ApiErrorEnvelope).toBeDefined();
  });

  it('uses server basePath with route-relative paths', () => {
    const doc = generateOpenApi([apiCap()], manifest);
    expect(doc.servers?.[0]?.url).toBe('/api/v1');
    expect(doc.paths['/refunds/{refundId}']).toBeDefined();
    expect(doc.paths['/api/v1/refunds/{refundId}']).toBeUndefined();
  });

  it('includes access.scopes when manifest auth scopes are absent', () => {
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string(), note: z.string().optional() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { scopes: ['refunds:write'] },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'ok' }),
    });
    const approveManifest: ApiManifest = {
      ...manifest,
      expose: [
        {
          capability: 'billing.approveRefund',
          operationId: 'approveRefund',
          method: 'POST',
          path: '/refunds/{refundId}/approve',
        },
      ],
    };
    const doc = generateOpenApi([cap], approveManifest);
    const postOp = doc.paths['/refunds/{refundId}/approve']?.post as {
      security?: { oauth2: string[] }[];
    };
    expect(postOp.security?.[0]?.oauth2).toContain('refunds:write');
    const schemes = doc.components?.securitySchemes as Record<
      string,
      { flows?: { clientCredentials?: { scopes?: Record<string, string> } } }
    >;
    expect(schemes.oauth2?.flows?.clientCredentials?.scopes?.['refunds:write']).toBe(
      'refunds:write',
    );
  });

  it('omits path parameters from non-GET requestBody schema', () => {
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string(), note: z.string().optional() }),
      output: z.object({ refundId: z.string(), status: z.string() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: {
        operationId: 'approveRefund',
        method: 'POST',
        path: '/refunds/{refundId}/approve',
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId, status: 'ok' }),
    });
    const approveManifest: ApiManifest = {
      ...manifest,
      expose: [
        {
          capability: 'billing.approveRefund',
          operationId: 'approveRefund',
          method: 'POST',
          path: '/refunds/{refundId}/approve',
        },
      ],
    };
    const doc = generateOpenApi([cap], approveManifest);
    const postOp = doc.paths['/refunds/{refundId}/approve']?.post as {
      requestBody?: {
        content?: { 'application/json'?: { schema?: { properties?: Record<string, unknown> } } };
      };
    };
    const props = postOp.requestBody?.content?.['application/json']?.schema?.properties ?? {};
    expect(props).toHaveProperty('note');
    expect(props).not.toHaveProperty('refundId');
  });
});

describe('mapCoreError', () => {
  it('mapCoreError maps validation to validation_failed', () => {
    const { body } = mapCoreError({ code: 'validation', message: 'bad' }, 'req_1', 'v1');
    expect(body.error.code).toBe('validation_failed');
  });

  it('mapCoreError maps notFound to not_found', () => {
    const { body } = mapCoreError({ code: 'notFound', message: 'x' }, 'req_1', 'v1');
    expect(body.error.code).toBe('not_found');
  });

  it('mapCoreError maps forbidden to forbidden', () => {
    const { body } = mapCoreError({ code: 'forbidden', message: 'x' }, 'req_1', 'v1');
    expect(body.error.code).toBe('forbidden');
  });

  it('mapCoreError maps conflict to conflict', () => {
    const { body } = mapCoreError({ code: 'conflict', message: 'x' }, 'req_1', 'v1');
    expect(body.error.code).toBe('conflict');
  });

  it('mapCoreError maps internal to internal_error with generic message', () => {
    const { body } = mapCoreError({ code: 'internal', message: 'secret details' }, 'req_1', 'v1');
    expect(body.error.code).toBe('internal_error');
    expect(body.error.message).toBe('An internal error occurred');
  });
});
