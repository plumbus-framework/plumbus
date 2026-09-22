import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../../define/defineEvent.js';
import { EventRegistry } from '../registry.js';

function makeEvent(name: string, domain?: string, version?: string) {
  return defineEvent({
    name,
    description: `Test event ${name}`,
    domain,
    version,
    payload: z.object({ value: z.string() }),
  });
}

describe('EventRegistry', () => {
  it('registers and retrieves an event by name', () => {
    const registry = new EventRegistry();
    const evt = makeEvent('order.created', 'orders');
    registry.register(evt);
    expect(registry.get('order.created')).toBe(evt);
  });

  it('retrieves by name@version key', () => {
    const registry = new EventRegistry();
    const evt = makeEvent('order.created', 'orders', '2');
    registry.register(evt);
    expect(registry.get('order.created@2')).toBe(evt);
  });

  it('throws on duplicate registration', () => {
    const registry = new EventRegistry();
    const evt = makeEvent('order.created');
    registry.register(evt);
    expect(() => registry.register(evt)).toThrow('already registered');
  });

  it('has() returns correct boolean', () => {
    const registry = new EventRegistry();
    expect(registry.has('nope')).toBe(false);
    registry.register(makeEvent('order.created'));
    expect(registry.has('order.created')).toBe(true);
  });

  it('getAll() lists all events', () => {
    const registry = new EventRegistry();
    registry.register(makeEvent('a'));
    registry.register(makeEvent('b'));
    expect(registry.getAll()).toHaveLength(2);
  });

  it('getByDomain() filters correctly', () => {
    const registry = new EventRegistry();
    registry.register(makeEvent('a.created', 'billing'));
    registry.register(makeEvent('b.created', 'orders'));
    registry.register(makeEvent('c.created', 'billing'));
    expect(registry.getByDomain('billing')).toHaveLength(2);
    expect(registry.getByDomain('orders')).toHaveLength(1);
    expect(registry.getByDomain('unknown')).toHaveLength(0);
  });
});
