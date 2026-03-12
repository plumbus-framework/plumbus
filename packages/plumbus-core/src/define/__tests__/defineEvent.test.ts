import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../defineEvent.js';

describe('defineEvent', () => {
  const validConfig = () => ({
    name: 'order.placed',
    payload: z.object({ orderId: z.string(), amount: z.number() }),
  });

  it('creates a valid event definition', () => {
    const event = defineEvent(validConfig());
    expect(event.name).toBe('order.placed');
  });

  it('freezes the returned definition', () => {
    const event = defineEvent(validConfig());
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('accepts optional fields', () => {
    const event = defineEvent({
      ...validConfig(),
      description: 'Emitted when a new order is placed',
      domain: 'orders',
      version: '1.0.0',
      tags: ['billing'],
    });
    expect(event.version).toBe('1.0.0');
    expect(event.domain).toBe('orders');
  });

  it('throws if name is missing', () => {
    expect(() => defineEvent({ ...validConfig(), name: '' })).toThrow('name is required');
  });

  it('throws if payload is not a Zod schema', () => {
    expect(() => defineEvent({ ...validConfig(), payload: {} as any })).toThrow(
      'payload must be a Zod schema',
    );
  });
});
