import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { isApiExposed } from '../exposure.js';

describe('isApiExposed', () => {
  const base = (): CapabilityContract => ({
    name: 'getUser',
    kind: 'query',
    domain: 'users',
    input: z.object({ userId: z.string() }),
    output: z.object({ id: z.string() }),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({ id: '1' }),
  });

  it('isApiExposed true when exposeAs includes api', () => {
    expect(isApiExposed({ ...base(), exposeAs: ['api'] })).toBe(true);
  });

  it('isApiExposed false when exposeAs is absent or mcp-only', () => {
    expect(isApiExposed(base())).toBe(false);
    expect(isApiExposed({ ...base(), exposeAs: ['mcp'] })).toBe(false);
  });
});
