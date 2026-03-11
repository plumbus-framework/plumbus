import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '../../types/event.js';
import { createInMemoryQueue } from '../queue.js';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    id: 'evt-1',
    eventType: 'order.created',
    version: '1',
    occurredAt: new Date(),
    actor: 'user-1',
    correlationId: 'corr-1',
    payload: { orderId: '123' },
    ...overrides,
  };
}

describe('InMemoryQueue', () => {
  it('delivers published events to subscribers', async () => {
    const queue = createInMemoryQueue();
    const received: EventEnvelope[] = [];
    queue.subscribe(async (e) => {
      received.push(e);
    });

    await queue.publish(makeEnvelope());
    expect(received).toHaveLength(1);
    expect(received[0]!.id).toBe('evt-1');
  });

  it('delivers to multiple subscribers', async () => {
    const queue = createInMemoryQueue();
    const a: string[] = [];
    const b: string[] = [];
    queue.subscribe(async (e) => {
      a.push(e.id);
    });
    queue.subscribe(async (e) => {
      b.push(e.id);
    });

    await queue.publish(makeEnvelope());
    expect(a).toEqual(['evt-1']);
    expect(b).toEqual(['evt-1']);
  });

  it('unsubscribe removes handler', async () => {
    const queue = createInMemoryQueue();
    const received: string[] = [];
    const unsub = queue.subscribe(async (e) => {
      received.push(e.id);
    });
    unsub();

    await queue.publish(makeEnvelope());
    expect(received).toEqual([]);
  });

  it('throws on publish after close', async () => {
    const queue = createInMemoryQueue();
    await queue.close();
    await expect(queue.publish(makeEnvelope())).rejects.toThrow('closed');
  });

  it('throws on subscribe after close', async () => {
    const queue = createInMemoryQueue();
    await queue.close();
    expect(() => queue.subscribe(async () => {})).toThrow('closed');
  });

  it('swallows subscriber errors without affecting others', async () => {
    const queue = createInMemoryQueue();
    const received: string[] = [];
    queue.subscribe(async () => {
      throw new Error('boom');
    });
    queue.subscribe(async (e) => {
      received.push(e.id);
    });

    await queue.publish(makeEnvelope());
    expect(received).toEqual(['evt-1']);
  });
});
