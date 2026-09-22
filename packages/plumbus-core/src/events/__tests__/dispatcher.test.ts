import { describe, expect, it, vi } from 'vitest';
import { createOutboxDispatcher } from '../dispatcher.js';
import { createInMemoryQueue } from '../queue.js';

/**
 * Tests the dispatcher polling logic with mocked DB.
 * We simulate outbox rows and verify queue.publish & status updates.
 */

function makeRow(id: string, eventType = 'order.created') {
  return {
    id,
    eventType,
    version: '1',
    payload: { orderId: id },
    actor: 'user-1',
    tenantId: 'tenant-1',
    correlationId: 'corr-1',
    causationId: null,
    occurredAt: new Date(),
    status: 'pending',
    dispatchedAt: null,
    retryCount: '0',
    lastError: null,
  };
}

function mockDb(rows: any[]) {
  const updates: any[] = [];
  const updateSet = vi.fn().mockImplementation((values: any) => ({
    where: vi.fn().mockImplementation(() => {
      updates.push(values);
      if (values.status === 'processing') {
        return {
          returning: vi.fn().mockImplementation(() => Promise.resolve([{ id: 'row-1' }])),
        };
      }
      return Promise.resolve();
    }),
    returning: vi.fn().mockImplementation(() => {
      updates.push(values);
      return {
        where: vi.fn().mockImplementation(() => {
          updates.push(values);
          return Promise.resolve([{ id: 'row-1' }]);
        }),
      };
    }),
  }));

  return {
    _updates: updates,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: updateSet,
    }),
  } as any;
}

describe('OutboxDispatcher', () => {
  it('polls pending rows and publishes to queue', async () => {
    const rows = [makeRow('e1'), makeRow('e2')];
    const db = mockDb(rows);
    const queue = createInMemoryQueue();
    const published: string[] = [];
    queue.subscribe(async (e) => {
      published.push(e.id);
    });

    const dispatcher = createOutboxDispatcher({ db, queue });
    const count = await dispatcher.poll();

    expect(count).toBe(2);
    expect(published).toEqual(['e1', 'e2']);
  });

  it('marks rows as dispatched after publish', async () => {
    const db = mockDb([makeRow('e1')]);
    const queue = createInMemoryQueue();

    const dispatcher = createOutboxDispatcher({ db, queue });
    await dispatcher.poll();

    expect(db._updates.some((u: any) => u.status === 'processing')).toBe(true);
    const dispatchedUpdate = db._updates.find((u: any) => u.status === 'dispatched');
    expect(dispatchedUpdate).toBeDefined();
    expect(dispatchedUpdate.dispatchedAt).toBeInstanceOf(Date);
  });

  it('marks row as failed when queue.publish throws', async () => {
    const db = mockDb([makeRow('e1')]);
    const queue = {
      publish: vi.fn().mockRejectedValue(new Error('queue down')),
      subscribe: vi.fn().mockReturnValue(() => {}),
      close: vi.fn(),
    };

    const dispatcher = createOutboxDispatcher({ db, queue });
    const count = await dispatcher.poll();

    expect(count).toBe(0);
    const retryUpdate = db._updates.find((u: any) => u.status === 'retry');
    expect(retryUpdate).toBeDefined();
    expect(retryUpdate.lastError).toBe('queue down');
    expect(retryUpdate.retryCount).toBe('1');
  });

  it('dead-letters row after max retries exhausted', async () => {
    const row = {
      ...makeRow('e1'),
      retryCount: '4',
      status: 'retry',
      dispatchedAt: new Date(Date.now() - 120_000),
    };
    const inserts: any[] = [];
    const db = mockDb([]);
    // Override select to return retry rows for second query
    let callCount = 0;
    db.select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockImplementation(() => {
              callCount++;
              return callCount === 1 ? Promise.resolve([]) : Promise.resolve([row]);
            }),
          }),
        }),
      }),
    });
    db.insert = vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((v: any) => {
        inserts.push(v);
        return Promise.resolve();
      }),
    });
    const queue = {
      publish: vi.fn().mockRejectedValue(new Error('still down')),
      subscribe: vi.fn().mockReturnValue(() => {}),
      close: vi.fn(),
    };

    const dispatcher = createOutboxDispatcher({ db, queue, maxRetries: 5 });
    await dispatcher.poll();

    expect(inserts).toHaveLength(1);
    expect(inserts[0].eventId).toBe('e1');
    expect(inserts[0].lastError).toBe('still down');
    // Row status updated to dead_lettered
    expect(db._updates.some((u: any) => u.status === 'dead_lettered')).toBe(true);
  });

  it('start/stop manages the polling interval', async () => {
    vi.useFakeTimers();
    try {
      const db = mockDb([]);
      const queue = createInMemoryQueue();
      const dispatcher = createOutboxDispatcher({ db, queue, pollIntervalMs: 500 });

      expect(dispatcher.isRunning).toBe(false);
      dispatcher.start();
      expect(dispatcher.isRunning).toBe(true);

      dispatcher.stop();
      expect(dispatcher.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns 0 when outbox is empty', async () => {
    const db = mockDb([]);
    const queue = createInMemoryQueue();
    const dispatcher = createOutboxDispatcher({ db, queue });
    const count = await dispatcher.poll();
    expect(count).toBe(0);
  });
});
