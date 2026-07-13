import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/defineCapability.js';
import { createCapabilityInvokeService } from '../capability-invocation.js';
import { createTestContext } from '../../testing/context.js';

describe('CapabilityService.describe (A6c)', () => {
  const target = defineCapability({
    name: 'describeTarget',
    kind: 'query',
    domain: 'test',
    description: 'target',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    access: { roles: ['system'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ ok: true }),
  });

  it('returns metadata and input JSON schema', () => {
    const ctx = createTestContext();
    const service = createCapabilityInvokeService(
      defineCapability({
        name: 'caller',
        kind: 'action',
        domain: 'test',
        description: 'caller',
        input: z.object({}),
        output: z.object({}),
        access: { roles: ['system'] },
        effects: {
          data: [],
          events: [],
          external: [],
          ai: false,
          capabilities: ['test.describeTarget'],
        },
        handler: async () => ({}),
      }),
      ctx,
      {
        invoker: async () => ({ success: true, data: {} }),
        resolveCapability: (name) => (name === 'test.describeTarget' ? target : undefined),
      },
    );
    const described = service.describe?.('test.describeTarget');
    expect(described?.name).toBe('describeTarget');
    expect(described?.domain).toBe('test');
    expect(described?.kind).toBe('query');
    expect(described?.inputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });
});
