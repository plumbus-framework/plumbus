import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineCapability } from '../../define/defineCapability.js';
import type { CapabilityContract } from '../../types/capability.js';
import { renderSkillFile } from '../skill-generator.js';

describe('renderSkillFile', () => {
  it('renders required sections', () => {
    const cap = defineCapability({
      name: 'getUser',
      kind: 'query',
      domain: 'users',
      description: 'Fetch user',
      exposeAs: ['mcp'],
      input: z.object({ userId: z.string() }),
      output: z.object({ id: z.string() }),
      effects: { data: ['User'], events: [], external: [], ai: false },
      access: { scopes: ['users:read'], tenantScoped: true },
      mcp: { dangerous: false, agentTags: ['identity'] },
      handler: async () => ({ id: '1' }),
    });

    const md = renderSkillFile(cap as unknown as CapabilityContract);
    expect(md).toContain('## Name');
    expect(md).toContain('getUser');
    expect(md).toContain('## Required Scopes');
    expect(md).toContain('users:read');
    expect(md).toContain('## Tenant Scoped');
    expect(md).toContain('yes');
    expect(md).toContain('identity');
    expect(md).toContain('## Dangerous');
    expect(md).toContain('no');
  });

  it('renders empty scopes gracefully', () => {
    const cap = defineCapability({
      name: 'ping',
      kind: 'query',
      domain: 'ops',
      description: 'Ping',
      exposeAs: ['mcp'],
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      effects: { data: [], events: [], external: [], ai: false },
      handler: async () => ({ ok: true }),
    });

    const md = renderSkillFile(cap as unknown as CapabilityContract);
    expect(md).toContain('## Required Scopes');
    expect(md).toContain('(none)');
  });
});
