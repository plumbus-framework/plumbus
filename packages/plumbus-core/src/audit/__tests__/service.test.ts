import { describe, expect, it, vi } from 'vitest';
import { bindAuditServiceToTransaction, createAuditService } from '../service.js';
import { PlumbusError } from '../../errors/index.js';
import { ErrorCode } from '../../types/enums.js';

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

  it('names a NUL byte in metadata instead of persisting it — jsonb refuses the escape', async () => {
    const db = makeMockDb();
    const service = createAuditService({
      db: db as any,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await service.record('probe.event', {
      outcome: 'failure',
      message: 'echo: bad\u0000raw',
      nested: { deep: 'still\u0000here' },
      list: ['a\u0000b', 'clean'],
    });

    const row = db.inserted[0] as { metadata?: Record<string, unknown> };
    const metadata = row.metadata as Record<string, unknown>;
    expect(metadata.message).toBe('echo: bad<NUL>raw');
    expect((metadata.nested as Record<string, unknown>).deep).toBe('still<NUL>here');
    expect(metadata.list).toEqual(['a<NUL>b', 'clean']);
    expect(JSON.stringify(metadata)).not.toContain('\\u0000');
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

it('surfaces a writer refusal as thrown, without retrying or relabelling it', async () => {
  const refusal = new PlumbusError(
    ErrorCode.Validation,
    'audit payload rejected at "metadata.recipient"',
    {
      path: 'metadata.recipient',
    },
  );
  const write = vi.fn().mockRejectedValue(refusal);
  const service = createAuditService({
    db: {} as never,
    auth: { userId: 'actor', roles: [], scopes: [], provider: 'test' },
    writer: { write },
  });
  await expect(service.record('event', { recipient: 'dean@college.test' })).rejects.toBe(refusal);
  expect(write).toHaveBeenCalledTimes(1);
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

describe('bindAuditServiceToTransaction', () => {
  const auth = { userId: 'user-1', roles: [], scopes: [], provider: 'test' } as const;

  /** A transaction handle whose writes can be made to fail (an aborted transaction). */
  function makeTx(options: { fail?: boolean } = {}) {
    const inserted: Array<{ id: string; action: string; outcome: string }> = [];
    return {
      inserted,
      insert: vi.fn().mockReturnValue({
        values: vi
          .fn()
          .mockImplementation((row: { id: string; action: string; outcome: string }) => ({
            onConflictDoNothing: () => {
              if (options.fail) return Promise.reject(new Error('current transaction is aborted'));
              inserted.push(row);
              return Promise.resolve();
            },
          })),
      }),
    };
  }

  it('returns undefined for an audit service with a custom writer', () => {
    const service = createAuditService({
      db: makeMockDb() as any,
      auth,
      writer: { write: vi.fn() },
    });
    expect(bindAuditServiceToTransaction(service, makeTx() as any)).toBeUndefined();
    expect(bindAuditServiceToTransaction({ record: vi.fn() }, makeTx() as any)).toBeUndefined();
  });

  it('writes through the transaction while it is open, not the outer database', async () => {
    const outer = makeMockDb();
    const tx = makeTx();
    const binding = bindAuditServiceToTransaction(
      createAuditService({ db: outer as any, auth, component: 'orders' }),
      tx as any,
    );
    await binding?.audit.record('order.created');
    expect(tx.inserted).toHaveLength(1);
    expect(tx.inserted[0]).toMatchObject({ action: 'order.created', component: 'orders' });
    expect(outer.inserted).toHaveLength(0);
    await binding?.committed();
    expect(outer.inserted).toHaveLength(0);
  });

  it('replays failure and denied records (same ids) after a rollback and drops success', async () => {
    const outer = makeMockDb();
    const tx = makeTx();
    const binding = bindAuditServiceToTransaction(
      createAuditService({ db: outer as any, auth }),
      tx as any,
    );
    await binding?.audit.record('step.ok');
    await binding?.audit.record('step.failed', { outcome: 'failure' });
    await binding?.audit.record('step.refused', { outcome: 'denied' });
    await binding?.rolledBack();

    const replayed = outer.inserted as Array<{ id: string; action: string }>;
    expect(replayed.map((row) => row.action)).toEqual(['step.failed', 'step.refused']);
    expect(replayed.map((row) => row.id)).toEqual(
      tx.inserted.filter((row) => row.outcome !== 'success').map((row) => row.id),
    );
  });

  it('routes writes to the outer writer after the transaction ended', async () => {
    const outer = makeMockDb();
    const tx = makeTx();
    const binding = bindAuditServiceToTransaction(
      createAuditService({ db: outer as any, auth }),
      tx as any,
    );
    await binding?.committed();
    await binding?.audit.record('late.success');
    expect(tx.inserted).toHaveLength(0);
    expect(outer.inserted).toMatchObject([{ action: 'late.success' }]);
  });

  it('keeps a failure the transaction refused and writes it once the transaction ends', async () => {
    const outer = makeMockDb();
    const binding = bindAuditServiceToTransaction(
      createAuditService({ db: outer as any, auth }),
      makeTx({ fail: true }) as any,
    );
    await expect(binding?.audit.record('step.failed', { outcome: 'failure' })).resolves.toBe(
      undefined,
    );
    await expect(binding?.audit.record('step.ok')).rejects.toMatchObject({
      message: 'Audit persistence failed',
    });
    await binding?.committed();
    expect(outer.inserted).toMatchObject([{ action: 'step.failed', outcome: 'failure' }]);
  });
});
