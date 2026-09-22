import { defineCapability } from '@plumbus/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { resolveExposure } from '../resolve.js';
import { validatePathParams } from '../path-params.js';

describe('validatePathParams', () => {
  it('flags unmapped path parameters', () => {
    const cap = defineCapability({
      name: 'getItem',
      kind: 'query',
      domain: 'billing',
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'getItem', method: 'GET', path: '/items/{itemId}' },
      handler: async () => ({ ok: true }),
    });
    const resolved = resolveExposure(cap);
    const findings = validatePathParams(cap, resolved);
    expect(findings.some((f) => f.code === 'manifest.path-param-unmapped')).toBe(true);
  });

  it('flags duplicate path parameter tokens', () => {
    const cap = defineCapability({
      name: 'getItem',
      kind: 'query',
      domain: 'billing',
      input: z.object({ itemId: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      exposeAs: ['api'],
      api: { operationId: 'getItem', method: 'GET', path: '/items/{itemId}/related/{itemId}' },
      handler: async () => ({ ok: true }),
    });
    const resolved = resolveExposure(cap);
    const findings = validatePathParams(cap, resolved);
    expect(findings.some((f) => f.code === 'manifest.path-param-collision')).toBe(true);
  });
});
