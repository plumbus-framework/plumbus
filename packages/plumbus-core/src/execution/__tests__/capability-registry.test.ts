import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CapabilityContract } from '../../types/capability.js';
import { CapabilityRegistry } from '../capability-registry.js';

function makeCap(name: string, domain = 'core'): CapabilityContract {
  return {
    name,
    kind: 'query',
    domain,
    input: z.object({}),
    output: z.object({}),
    effects: { data: [], events: [], external: [], ai: false },
    handler: async () => ({}),
  } as CapabilityContract;
}

describe('CapabilityRegistry', () => {
  it('registers and retrieves a capability', () => {
    const reg = new CapabilityRegistry();
    const cap = makeCap('getUser', 'users');
    reg.register(cap);

    expect(reg.get('getUser')).toBe(cap);
    expect(reg.has('getUser')).toBe(true);
  });

  it('throws on duplicate registration', () => {
    const reg = new CapabilityRegistry();
    reg.register(makeCap('getUser'));

    expect(() => reg.register(makeCap('getUser'))).toThrow(
      'Capability "getUser" is already registered',
    );
  });

  it('returns undefined for unknown capability', () => {
    const reg = new CapabilityRegistry();
    expect(reg.get('missing')).toBeUndefined();
    expect(reg.has('missing')).toBe(false);
  });

  it('registers multiple capabilities', () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([makeCap('a'), makeCap('b'), makeCap('c')]);
    expect(reg.getAll()).toHaveLength(3);
  });

  it('filters by domain', () => {
    const reg = new CapabilityRegistry();
    reg.registerAll([
      makeCap('getUser', 'users'),
      makeCap('createUser', 'users'),
      makeCap('getProject', 'projects'),
    ]);

    const userCaps = reg.getByDomain('users');
    expect(userCaps).toHaveLength(2);
    expect(userCaps.map((c) => c.name)).toEqual(['getUser', 'createUser']);
  });
});
