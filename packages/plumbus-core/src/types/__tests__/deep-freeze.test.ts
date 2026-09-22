import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { deepFreeze } from '../deep-freeze.js';

describe('deepFreeze', () => {
  it('freezes nested objects and arrays', () => {
    const def = deepFreeze({
      access: { roles: ['admin'] },
      effects: { data: ['users:read'] },
    });

    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.access)).toBe(true);
    expect(Object.isFrozen(def.effects)).toBe(true);
    expect(() => {
      def.access.roles.push('system');
    }).toThrow();
  });

  it('freezes nested arrays element-wise', () => {
    const def = deepFreeze({ items: [{ id: 1 }, { id: 2 }] });
    expect(Object.isFrozen(def.items)).toBe(true);
    expect(Object.isFrozen(def.items[0])).toBe(true);
    expect(() => {
      (def.items[0] as { id: number }).id = 99;
    }).toThrow();
  });

  it('does not freeze functions (handlers stay callable)', () => {
    const handler = (): string => 'ok';
    const def = deepFreeze({ handler });
    expect(Object.isFrozen(def)).toBe(true);
    // Function reference still callable; not frozen by deepFreeze
    expect(def.handler()).toBe('ok');
  });

  it('does not freeze Zod schemas (runtime validation must still work)', () => {
    const input = z.object({ amount: z.number() });
    const def = deepFreeze({ input });
    expect(Object.isFrozen(def)).toBe(true);
    // The schema itself is not deep-frozen — safeParse() still works.
    const result = def.input.safeParse({ amount: 1 });
    expect(result.success).toBe(true);
  });

  it('returns primitives unchanged', () => {
    expect(deepFreeze(42)).toBe(42);
    expect(deepFreeze('s')).toBe('s');
    expect(deepFreeze(null as unknown as object)).toBe(null);
  });

  it('skips already-frozen subtrees without recursion errors', () => {
    const shared = Object.freeze({ tag: 'shared' });
    const def = deepFreeze({ a: shared, b: shared });
    expect(Object.isFrozen(def)).toBe(true);
    expect(def.a).toBe(shared);
  });
});
