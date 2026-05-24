import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/defineCapability.js';
import { CapabilityRegistry } from '../../execution/capability-registry.js';
import type { CapabilityContract } from '../../types/capability.js';
import { isMcpExposed } from '../exposure.js';
import { buildMcpManifest } from '../manifest-generator.js';

describe('buildMcpManifest', () => {
  const base = {
    kind: 'query' as const,
    domain: 'billing',
    input: z.object({ id: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: ['Refund'], events: [], external: [], ai: false },
    handler: async () => ({ id: '1' }),
  };

  it('includes only MCP-exposed capabilities', () => {
    const mcpCap = defineCapability({
      ...base,
      name: 'getRefund',
      description: 'Get refund',
      exposeAs: ['mcp'],
    });
    const other = defineCapability({
      ...base,
      name: 'listRefunds',
      description: 'List',
    });
    const registry = new CapabilityRegistry();
    registry.registerAll([mcpCap, other] as unknown as CapabilityContract[]);

    const manifest = buildMcpManifest(registry);
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0]?.name).toBe('getRefund');
  });

  it('serializes input schema and annotations', () => {
    const cap = defineCapability({
      ...base,
      name: 'approveRefund',
      description: 'Approve',
      exposeAs: ['mcp'],
      mcp: { dangerous: true, agentTags: ['billing'] },
      kind: 'action',
    });
    const registry = new CapabilityRegistry();
    registry.register(cap as unknown as CapabilityContract);

    const tool = buildMcpManifest(registry).tools[0];
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
    expect(tool?.annotations.destructiveHint).toBe(true);
    expect(tool?.annotations.readOnlyHint).toBe(false);
    expect(tool?.agentTags).toEqual(['billing']);
  });

  it('tag-only does not expose', () => {
    const cap = defineCapability({
      ...base,
      name: 'tagged',
      description: 'x',
      tags: ['mcp:expose'],
    });
    expect(isMcpExposed(cap as unknown as CapabilityContract)).toBe(false);
  });
});
