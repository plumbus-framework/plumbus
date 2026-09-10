import { describe, expect, it, vi } from 'vitest';
import { createAuditService } from '../service.js';

function makeMockDb() {
  const inserted: unknown[] = [];
  return {
    inserted,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((row: unknown) => {
        inserted.push(row);
        return { onConflictDoNothing: () => Promise.resolve() };
      }),
    }),
  };
}

describe('createAuditService', () => {
  it('records an audit event with correct fields', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        roles: ['admin'],
        scopes: [],
        provider: 'test',
      },
      component: 'orders',
    });

    await service.record('order.created', { orderId: '123', outcome: 'success' });

    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(db.inserted[0]).toMatchObject({
      actor: 'user-1',
      tenantId: 'tenant-1',
      component: 'orders',
      action: 'order.created',
      outcome: 'success',
    });
  });

  it('defaults actor to anonymous when userId is undefined', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: undefined, roles: [], scopes: [], provider: 'anonymous' },
    });

    await service.record('system.ping');

    expect(db.inserted[0]).toMatchObject({
      actor: 'anonymous',
      component: 'system',
    });
  });

  it('defaults outcome to success when not provided', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await service.record('check');

    expect(db.inserted[0]).toMatchObject({ outcome: 'success' });
  });

  it('strips _maskedFields from stored metadata', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await service.record('sensitive.op', {
      email: '***MASKED***',
      _maskedFields: ['email'],
    });

    const row = db.inserted[0] as Record<string, unknown>;
    expect(row.maskedFields).toEqual(['email']);
    const meta = row.metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty('_maskedFields');
    expect(meta).toHaveProperty('email', '***MASKED***');
  });

  it('records null metadata when none provided', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await service.record('simple.event');

    const row = db.inserted[0] as Record<string, unknown>;
    expect(row.metadata).toBeNull();
  });

  it('passes tenantId as null when not in auth', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await service.record('event');

    const row = db.inserted[0] as Record<string, unknown>;
    expect(row.tenantId).toBeNull();
  });

  it('uses injected AuditWriter instead of direct db insert', async () => {
    const db = makeMockDb();
    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    const service = createAuditService({
      db: db as any,
      auth: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        roles: ['admin'],
        scopes: [],
        provider: 'test',
      },
      component: 'orders',
      writer,
    });

    await service.record('order.created', { orderId: '123', outcome: 'success' });

    expect(writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'user-1',
        tenantId: 'tenant-1',
        component: 'orders',
        action: 'order.created',
        outcome: 'success',
        metadata: { orderId: '123', outcome: 'success' },
      }),
    );
    expect(db.insert).not.toHaveBeenCalled();
  });
});

it('retries transient writer failures with the same event identity and propagates permanent failures', async () => {
  const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const service = createAuditService({
    db: {} as never,
    auth: { userId: 'actor', roles: [], scopes: [], provider: 'test' },
    writer: { write },
  });
  await service.record('event');
  expect(write).toHaveBeenCalledTimes(2);
  expect(write.mock.calls[0]?.[0].id).toBe(write.mock.calls[1]?.[0].id);
  write.mockReset().mockRejectedValue(new Error('offline'));
  await expect(service.record('event')).rejects.toThrow('Audit persistence failed');
  expect(write).toHaveBeenCalledTimes(3);
});

it('rejects unsupported audit outcomes before writing', async () => {
  const write = vi.fn();
  const service = createAuditService({
    db: {} as never,
    auth: { roles: [], scopes: [], provider: 'test' },
    writer: { write },
  });
  await expect(service.record('event', { outcome: 'forged' })).rejects.toThrow(
    'Invalid audit outcome',
  );
  expect(write).not.toHaveBeenCalled();
});
