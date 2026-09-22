import { describe, expect, it } from 'vitest';
import { z } from '@plumbus/core/zod';
import { defineCapability } from '@plumbus/core';
import { createTestContext } from '@plumbus/core/testing';
import { capabilityBacked } from '../capability-backed.js';

describe('capabilityBacked', () => {
  const readCap = defineCapability({
    name: 'list-titles',
    kind: 'query',
    domain: 'test',
    input: z.object({}),
    output: z.array(z.object({ title: z.string() })),
    access: { roles: ['user', 'admin'] },
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => [{ title: 'A' }, { title: 'B' }],
  });

  it('formats capability output', async () => {
    const ctx = createTestContext();
    const provider = capabilityBacked({
      capability: readCap,
      format: (rows) => rows.map((r) => r.title).join(', '),
    });
    const block = await provider.getBlock(ctx, {});
    expect(block).toBe('A, B');
  });

  it('rejects side-effecting capability', () => {
    const writeCap = defineCapability({
      name: 'write-user',
      kind: 'action',
      domain: 'test',
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
      effects: { data: ['User'], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });
    expect(() => capabilityBacked({ capability: writeCap })).toThrow(
      /knowledge\.capability_not_readonly/,
    );
  });
});
