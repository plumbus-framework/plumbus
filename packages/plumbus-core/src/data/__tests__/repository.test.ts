import { describe, expect, it, vi } from 'vitest';
import { field } from '../../fields/index.js';
import type { AuditService } from '../../types/audit.js';
import type { EntityDefinition } from '../../types/entity.js';
import type { AuthContext } from '../../types/security.js';
import { createRepository } from '../repository.js';
import { generateDrizzleSchema } from '../schema-generator.js';

function makeEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name: 'Document',
    fields: {
      id: field.id(),
      title: field.string({ required: true }),
      secret: field.string({ classification: 'sensitive' }),
      token: field.string({ maskedInLogs: true }),
    },
    ...overrides,
  };
}

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: 'user-1',
    roles: ['admin'],
    scopes: [],
    provider: 'test',
    tenantId: 'tenant-1',
    ...overrides,
  };
}

// Mock Drizzle database that captures calls
function makeMockDb() {
  const returnRows = [{ id: 'row-1', title: 'Test', secret: 's3cret', token: 'tok' }];

  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(returnRows),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(returnRows),
  };

  return {
    select: vi.fn().mockReturnValue(chainable),
    insert: vi.fn().mockReturnValue(chainable),
    update: vi.fn().mockReturnValue(chainable),
    delete: vi.fn().mockReturnValue(chainable),
    _chainable: chainable,
    _rows: returnRows,
  };
}

describe('createRepository', () => {
  it('creates a repository with expected methods', () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    expect(repo.findById).toBeTypeOf('function');
    expect(repo.create).toBeTypeOf('function');
    expect(repo.update).toBeTypeOf('function');
    expect(repo.delete).toBeTypeOf('function');
    expect(repo.findMany).toBeTypeOf('function');
  });

  it('findById queries the database', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    const result = await repo.findById('row-1');
    expect(result).toEqual(db._rows[0]);
    expect(db.select).toHaveBeenCalled();
  });

  it('create inserts and returns the row', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    const result = await repo.create({ title: 'New' } as any);
    expect(result).toEqual(db._rows[0]);
    expect(db.insert).toHaveBeenCalled();
  });

  it('create injects tenantId for tenant-scoped entities', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    const auth = makeAuth({ tenantId: 't-42' });

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth,
    });

    await repo.create({ title: 'Test' } as any);
    // Verify values() was called with tenantId injected
    const valuesCall = db._chainable.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesCall?.tenantId).toBe('t-42');
  });

  it('throws when tenant-scoped entity used without tenantId', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    const auth = makeAuth({ tenantId: undefined });

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth,
    });

    await expect(repo.create({ title: 'X' } as any)).rejects.toThrow('requires auth.tenantId');
  });

  it('records audit event when tenant context is missing (H6)', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    const auth = makeAuth({ tenantId: undefined, userId: 'u-1' });
    const audit = { record: vi.fn().mockResolvedValue(undefined) };

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth,
      audit,
    });

    await expect(repo.findMany()).rejects.toThrow('requires auth.tenantId');
    expect(audit.record).toHaveBeenCalledWith(
      `${entity.name}.tenant_denied`,
      expect.objectContaining({
        operation: 'findMany',
        actor: 'u-1',
        reason: 'missing_tenant_context',
      }),
    );
  });

  it('update calls db.update with set and where', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    const result = await repo.update('row-1', { title: 'Updated' } as any);
    expect(result).toEqual(db._rows[0]);
    expect(db.update).toHaveBeenCalled();
  });

  it('delete calls db.delete with where', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    await repo.delete('row-1');
    expect(db.delete).toHaveBeenCalled();
  });

  it('findMany returns all rows', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    // findMany uses select().from().where() without limit
    db._chainable.where = vi.fn().mockResolvedValue(db._rows);

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    const results = await repo.findMany();
    expect(results).toEqual(db._rows);
  });

  it('audit service records mutations with masked fields', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    const audit: AuditService = { record: vi.fn().mockResolvedValue(undefined) };

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
      audit,
    });

    await repo.create({ title: 'Audited', secret: 'password', token: 'abc' } as any);

    expect(audit.record).toHaveBeenCalledWith(
      'Document.create',
      expect.objectContaining({
        title: 'Audited',
        secret: '***', // masked due to classification=sensitive
        token: '***', // masked due to maskedInLogs=true
        _maskedFields: ['secret', 'token'],
      }),
    );
  });

  it('does not call audit when no audit service provided', async () => {
    const entity = makeEntity();
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    // Should not throw
    await repo.create({ title: 'No audit' } as any);
  });

  it('bypassTenantScope skips tenant filtering for tenant-scoped entities', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();
    db._chainable.where = vi.fn().mockResolvedValue(db._rows);

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth({ tenantId: 'admin' }),
      bypassTenantScope: true,
    });

    const results = await repo.findMany();
    expect(results).toEqual(db._rows);
    // where() is called but tenant filter should be skipped (undefined)
    expect(db._chainable.where).toHaveBeenCalled();
  });

  it('bypassTenantScope does not inject tenantId on create', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const db = makeMockDb();

    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth({ tenantId: 'admin' }),
      bypassTenantScope: true,
    });

    await repo.create({ title: 'Cross-tenant' } as any);
    const valuesCall = db._chainable.values.mock.calls[0]?.[0] as Record<string, unknown>;
    // When bypassing, tenantId should NOT be injected
    expect(valuesCall?.tenantId).toBeUndefined();
  });

  describe('createMany', () => {
    it('returns [] for empty input and does not touch the database', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const audit: AuditService = { record: vi.fn().mockResolvedValue(undefined) };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
        audit,
      });

      const result = await repo.createMany([]);
      expect(result).toEqual([]);
      expect(db.insert).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('inserts all records in a single call and returns rows', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const rows = [
        { id: 'r-1', title: 'A' },
        { id: 'r-2', title: 'B' },
        { id: 'r-3', title: 'C' },
      ];
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(rows),
        set: vi.fn().mockReturnThis(),
        values: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue(rows),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      const result = await repo.createMany([{ title: 'A' }, { title: 'B' }, { title: 'C' }] as any);

      expect(result).toEqual(rows);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(chainable.values).toHaveBeenCalledTimes(1);
      const valuesArg = chainable.values.mock.calls[0]?.[0] as unknown[];
      expect(Array.isArray(valuesArg)).toBe(true);
      expect(valuesArg).toHaveLength(3);
    });

    it('injects tenantId into every record for tenant-scoped entities', async () => {
      const entity = makeEntity({ tenantScoped: true });
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const auth = makeAuth({ tenantId: 't-7' });

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth,
      });

      await repo.createMany([{ title: 'One' }, { title: 'Two' }] as any);
      const valuesArg = db._chainable.values.mock.calls[0]?.[0] as Record<string, unknown>[];
      expect(valuesArg).toHaveLength(2);
      expect(valuesArg[0]?.tenantId).toBe('t-7');
      expect(valuesArg[1]?.tenantId).toBe('t-7');
    });

    it('throws when tenant-scoped entity used without tenantId', async () => {
      const entity = makeEntity({ tenantScoped: true });
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const auth = makeAuth({ tenantId: undefined });

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth,
      });

      await expect(repo.createMany([{ title: 'X' }] as any)).rejects.toThrow(
        'requires auth.tenantId',
      );
    });

    it('writes exactly one summary audit row per batch', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const audit: AuditService = { record: vi.fn().mockResolvedValue(undefined) };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
        audit,
      });

      await repo.createMany([
        { title: 'A', secret: 's1', token: 't1' },
        { title: 'B', secret: 's2', token: 't2' },
        { title: 'C', secret: 's3', token: 't3' },
      ] as any);

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        'Document.createMany',
        expect.objectContaining({
          count: 3,
          sample: expect.objectContaining({
            title: 'A',
            secret: '***',
            token: '***',
          }),
        }),
      );
    });

    it('does not call audit when no audit service provided', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      // Should not throw
      await repo.createMany([{ title: 'A' }, { title: 'B' }] as any);
      expect(db.insert).toHaveBeenCalledTimes(1);
    });
  });

  describe('findMany with options', () => {
    it('applies limit and offset', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const rows = [
        { id: 'r-1', title: 'A' },
        { id: 'r-2', title: 'B' },
      ];
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue(rows),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      const result = await repo.findMany({}, { limit: 2, offset: 10 });
      expect(result).toEqual(rows);
      expect(chainable.limit).toHaveBeenCalledWith(2);
      expect(chainable.offset).toHaveBeenCalledWith(10);
    });

    it('caps limit at 100', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      await repo.findMany({}, { limit: 500 });
      expect(chainable.limit).toHaveBeenCalledWith(100);
    });

    it('clamps negative offset to 0', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        offset: vi.fn().mockResolvedValue([]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      await repo.findMany({}, { offset: -10 });
      expect(chainable.offset).toHaveBeenCalledWith(0);
    });

    it('applies orderBy when column exists on table', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        offset: vi.fn().mockResolvedValue([]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      await repo.findMany({}, { orderBy: 'title', orderDir: 'asc' });
      expect(chainable.orderBy).toHaveBeenCalled();
    });

    it('ignores orderBy when column does not exist on table', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
        offset: vi.fn().mockResolvedValue([]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      await repo.findMany({}, { orderBy: 'nonexistent_column' });
      expect(chainable.orderBy).not.toHaveBeenCalled();
    });

    it('returns all results when no options provided (backward compat)', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const rows = [{ id: '1' }, { id: '2' }, { id: '3' }];
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(rows),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      const result = await repo.findMany();
      expect(result).toEqual(rows);
    });
  });

  describe('count', () => {
    it('returns total matching rows', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ count: 42 }]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      const total = await repo.count();
      expect(total).toBe(42);
    });

    it('applies query filters to count', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      };
      const db = {
        select: vi.fn().mockReturnValue(chainable),
        insert: vi.fn().mockReturnValue(chainable),
        update: vi.fn().mockReturnValue(chainable),
        delete: vi.fn().mockReturnValue(chainable),
      };

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
      });

      const total = await repo.count({ title: 'test' } as any);
      expect(total).toBe(5);
      expect(chainable.where).toHaveBeenCalled();
    });
  });
});
