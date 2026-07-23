import { describe, expect, it } from 'vitest';
import { defineCapability } from '@plumbus/core';
import { z } from 'zod';
import type { ApiManifest } from '../types.js';
import { validateSecurityConfig } from '../validate-security.js';
import { validateApiContract } from '../../validate.js';

const baseManifest: ApiManifest = {
  apiVersion: 'plumbus.dev/v1',
  name: 'partner-api',
  basePath: '/api/v1',
  expose: [
    {
      capability: 'billing.getRefund',
      operationId: 'getRefund',
      method: 'GET',
      path: '/refunds/{refundId}',
      auth: { scheme: 'partnerOAuth', scopes: ['refunds:read'] },
    },
  ],
};

describe('validateSecurityConfig', () => {
  it('flags legacy defaultAuth', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      identity: { defaultAuth: 'oauth2' },
    });
    const legacy = findings.find((f) => f.code === 'manifest.security.legacy-default-auth');
    expect(legacy).toBeDefined();
    expect(legacy?.severity).toBe('warning');
  });

  it('flags unknown default security scheme', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      identity: { defaultSecurityScheme: 'missing' },
    });
    expect(findings.some((f) => f.code === 'manifest.security.unknown-default-scheme')).toBe(true);
  });

  it('flags invented oauth token url', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      securitySchemes: {
        partnerOAuth: {
          type: 'oauth2',
          flows: { clientCredentials: { tokenUrl: '/oauth/token' } },
        },
      },
    });
    expect(findings.some((f) => f.code === 'manifest.security.invented-token-url')).toBe(true);
  });

  it('flags scopes without a security scheme', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      expose: [
        {
          capability: 'billing.getRefund',
          operationId: 'getRefund',
          method: 'GET',
          path: '/refunds/{refundId}',
          auth: { scopes: ['refunds:read'] },
        },
      ],
    });
    expect(findings.some((f) => f.code === 'manifest.security.scopes-without-scheme')).toBe(true);
  });

  it('passes explicit security scheme configuration', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      identity: { defaultSecurityScheme: 'partnerOAuth' },
      securitySchemes: {
        partnerOAuth: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://identity.example.com/oauth2/token',
              scopes: { 'refunds:read': 'Read refunds' },
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
      ],
    });
    expect(findings).toHaveLength(0);
  });

  it('keeps legacy defaultAuth manifests valid with warnings only', async () => {
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
        auth: { scopes: ['refunds:read'] },
      },
      handler: async (_ctx, input) => ({ refundId: input.refundId }),
    });
    const legacyManifest: ApiManifest = {
      apiVersion: 'plumbus.dev/v1',
      name: 'partner-api',
      basePath: '/api/v1',
      identity: { defaultAuth: 'partnerOAuth' },
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
    const result = await validateApiContract(legacyManifest, [cap], process.cwd());
    expect(result.ok).toBe(true);
    expect(result.security.some((f) => f.code === 'manifest.security.legacy-default-auth')).toBe(
      true,
    );
  });

  it('accepts authorizationCode-only oauth2 schemes', () => {
    const findings = validateSecurityConfig({
      ...baseManifest,
      securitySchemes: {
        partnerOAuth: {
          type: 'oauth2',
          flows: {
            authorizationCode: {
              tokenUrl: 'https://identity.example.com/oauth2/token',
              authorizationUrl: 'https://identity.example.com/oauth2/authorize',
            },
          },
        },
      },
    });
    expect(findings).toHaveLength(0);
  });
});
