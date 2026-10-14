import { describe, expect, it, vi } from 'vitest';
import { createEventWorker } from '../worker.js';
import { ConsumerRegistry } from '../consumer-registry.js';
import { createInMemoryQueue } from '../queue.js';
import { DataValidationError, DataInternalError } from '../../errors/index.js';

function fixture(options: any = {}) {
  const rows: any[] = [];
  const insert = vi.fn(async (row) => {
    rows.push(row);
  });
  const consumers = new ConsumerRegistry();
  const audit = { record: vi.fn(async () => {}) };
  const hook = vi.fn(async () => {});
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  const worker = createEventWorker({
    db: { insert: () => ({ values: insert }) } as any,
    queue: createInMemoryQueue(),
    consumers,
    idempotency: { isProcessed: async () => false, markProcessed: vi.fn(async () => {}) } as any,
    audit: audit as any,
    logger,
    onEventDeadLetter: hook,
    retry: { maxAttempts: 3, baseDelayMs: 0 },
    ...options,
  });
  const envelope = {
    id: 'event',
    eventType: 'type',
    version: '1',
    occurredAt: new Date(),
    actor: 'actor',
    correlationId: 'correlation',
    payload: { secret: 'private' },
  };
  return { worker, consumers, envelope, rows, insert, hook, audit, logger };
}
describe('event delivery policies', () => {
  it('honors per-consumer total attempts and classifies permanent errors', async () => {
    const f = fixture();
    const transient = vi.fn().mockRejectedValue(new Error('private'));
    const permanent = vi.fn().mockRejectedValue(new DataValidationError('private'));
    f.consumers.register({
      id: 'transient',
      eventTypes: ['type'],
      retry: { maxAttempts: 2 },
      handler: transient,
    });
    f.consumers.register({ id: 'permanent', eventTypes: ['type'], handler: permanent });
    await f.worker.deliver(f.envelope);
    expect(transient).toHaveBeenCalledTimes(2);
    expect(permanent).toHaveBeenCalledTimes(1);
    expect(f.rows.map((row) => row.metadata.reason)).toEqual(['exhausted', 'permanent']);
    expect(JSON.stringify(f.hook.mock.calls)).not.toContain('private');
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('private');
  });
  it('does not announce a dead letter when persistence fails', async () => {
    const f = fixture();
    f.insert.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.worker.deliver(f.envelope)).rejects.toThrow('database unavailable');
    expect(f.hook).not.toHaveBeenCalled();
    expect(
      f.audit.record.mock.calls.some(([action]) => action === 'event.consumer.dead_lettered'),
    ).toBe(false);
  });
  it('persists unrouted messages by default and permits explicit intentional ignores', async () => {
    const strict = fixture();
    await strict.worker.deliver(strict.envelope);
    expect(strict.rows[0]?.metadata.reason).toBe('unrouted');
    const ignored = fixture({ ignoredEventTypes: ['type'] });
    await ignored.worker.deliver(ignored.envelope);
    expect(ignored.rows).toHaveLength(0);
    expect(ignored.logger.warn).toHaveBeenCalled();
  });
  it('isolates a failing notification after persistence', async () => {
    const f = fixture();
    f.hook.mockRejectedValueOnce(new Error('notification failed'));
    await expect(f.worker.deliver(f.envelope)).resolves.toBeUndefined();
    expect(f.rows).toHaveLength(1);
    expect(f.logger.error).toHaveBeenCalledWith(
      'Event dead-letter notification failed',
      expect.any(Object),
    );
  });
});

it('retains a delivery waiting for an active job claim without exhausting it into the DLQ', async () => {
  const f = fixture();
  const busy = new DataInternalError('Job is running', { deliveryDeferred: true });
  const handler = vi.fn().mockRejectedValue(busy);
  f.consumers.register({ id: 'job:test.work', eventTypes: ['type'], handler });
  await expect(f.worker.deliver(f.envelope)).rejects.toBe(busy);
  expect(handler).toHaveBeenCalledOnce();
  expect(f.rows).toEqual([]);
  expect(f.hook).not.toHaveBeenCalled();
});

it('inherits the pool delay ceiling for a consumer override and honors its delay', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture({ retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 60000 } });
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue(undefined);
    f.consumers.register({
      id: 'slow-retry',
      eventTypes: ['type'],
      retry: { baseDelayMs: 10000 },
      handler,
    });
    const delivery = f.worker.deliver(f.envelope);
    await vi.advanceTimersByTimeAsync(9999);
    expect(handler).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await delivery;
    expect(handler).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
