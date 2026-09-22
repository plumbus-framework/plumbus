import { defineCapability } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ApiManifest } from '../../manifest/types.js';
import { validatePolicy } from '../validate-policy.js';

describe('validatePolicy', () => {
  const baseManifest = (policy: ApiManifest['policy']): ApiManifest => ({
    apiVersion: 'plumbus.dev/v1',
    name: 'test',
    basePath: '/api/v1',
    policy,
    expose: [
      {
        capability: 'billing.listUsers',
        operationId: 'listUsers',
        method: 'GET',
        path: '/users',
      },
    ],
  });

  it('flags tenantId in query under auth-context', () => {
    const cap = defineCapability({
      name: 'listUsers',
      kind: 'query',
      domain: 'billing',
      input: z.object({ tenantId: z.string() }),
      output: z.object({ users: z.array(z.string()) }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'listUsers', method: 'GET', path: '/users' },
      handler: async () => ({ users: [] }),
    });

    const findings = validatePolicy(
      baseManifest({
        tenantRouting: { mode: 'auth-context', forbidExplicitTenantInput: true },
      }),
      [cap],
    );
    expect(findings.some((f) => f.code === 'policy.tenant-input-forbidden')).toBe(true);
  });

  it('flags mutation capability over GET', () => {
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'approveRefund', method: 'GET', path: '/refunds' },
      handler: async () => ({ ok: true }),
    });

    const manifest: ApiManifest = {
      apiVersion: 'plumbus.dev/v1',
      name: 'test',
      basePath: '/api/v1',
      policy: { methodSemantics: { forbidMutationOverGet: true } },
      expose: [
        {
          capability: 'billing.approveRefund',
          operationId: 'approveRefund',
          method: 'GET',
          path: '/refunds',
        },
      ],
    };

    const findings = validatePolicy(manifest, [cap]);
    expect(findings.some((f) => f.code === 'policy.mutation-over-get')).toBe(true);
  });

  it('flags non-query GET with non-path input fields', () => {
    const cap = defineCapability({
      name: 'approveRefund',
      kind: 'action',
      domain: 'billing',
      input: z.object({ refundId: z.string(), reason: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'approveRefund', method: 'GET', path: '/refunds' },
      handler: async () => ({ ok: true }),
    });

    const manifest: ApiManifest = {
      apiVersion: 'plumbus.dev/v1',
      name: 'test',
      basePath: '/api/v1',
      policy: { methodSemantics: { forbidGetBody: true } },
      expose: [
        {
          capability: 'billing.approveRefund',
          operationId: 'approveRefund',
          method: 'GET',
          path: '/refunds',
        },
      ],
    };

    const findings = validatePolicy(manifest, [cap]);
    expect(findings.some((f) => f.code === 'policy.get-with-body')).toBe(true);
  });

  it('flags public capability with test intent enabled', () => {
    const cap = defineCapability({
      name: 'health',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      access: { public: true },
      exposeAs: ['api'],
      api: {
        operationId: 'health',
        method: 'GET',
        path: '/health',
        test: { enabled: true, modes: ['validate-only'] },
      },
      handler: async () => ({ ok: true }),
    });

    const manifest: ApiManifest = {
      apiVersion: 'plumbus.dev/v1',
      name: 'test',
      basePath: '/api/v1',
      expose: [
        {
          capability: 'billing.health',
          operationId: 'health',
          method: 'GET',
          path: '/health',
          test: { enabled: true, modes: ['validate-only'] },
        },
      ],
    };

    const findings = validatePolicy(manifest, [cap]);
    expect(findings.some((f) => f.code === 'policy.public-test-forbidden')).toBe(true);
  });

  it('allows query capability over GET', () => {
    const cap = defineCapability({
      name: 'listUsers',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ users: z.array(z.string()) }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'listUsers', method: 'GET', path: '/users' },
      handler: async () => ({ users: [] }),
    });

    const findings = validatePolicy(
      baseManifest({ methodSemantics: { forbidMutationOverGet: true } }),
      [cap],
    );
    expect(findings.some((f) => f.code === 'policy.mutation-over-get')).toBe(false);
  });
});
