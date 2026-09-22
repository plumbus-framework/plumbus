import { describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    isNull: vi.fn((column: Parameters<typeof actual.isNull>[0]) => actual.isNull(column)),
  };
});

import { isNull } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
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

  it('refuses update without WHERE when entity has no id and is not tenant-scoped', async () => {
    const entity = makeEntity({
      tenantScoped: false,
      fields: { title: field.string({ required: true }) },
    });
    const table = {} as ReturnType<typeof generateDrizzleSchema>;
    const db = makeMockDb();
    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    await expect(repo.update('any', { title: 'x' } as any)).rejects.toThrow(/Refusing to update/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('refuses delete without WHERE when entity has no id and is not tenant-scoped', async () => {
    const entity = makeEntity({
      tenantScoped: false,
      fields: { title: field.string({ required: true }) },
    });
    const table = {} as ReturnType<typeof generateDrizzleSchema>;
    const db = makeMockDb();
    const repo = createRepository({
      entity,
      table,
      db: db as any,
      auth: makeAuth(),
    });

    await expect(repo.delete('any')).rejects.toThrow(/Refusing to delete/);
    expect(db.delete).not.toHaveBeenCalled();
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

  describe('count with search/in/notEq', () => {
    it('honors search filter', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ count: 2 }]),
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

      const total = await repo.count({}, { search: { columns: ['title'], term: 'test' } });
      expect(total).toBe(2);
      expect(chainable.where).toHaveBeenCalled();
    });

    it('escapes LIKE metacharacters in the search term so it matches literally', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const chainable = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue([{ id: 'row-1', title: 'Test' }]),
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

      await repo.findMany({}, { search: { columns: ['title'], term: '50%_x' } });

      const whereArg = chainable.where.mock.calls[0]?.[0];
      const { params } = new PgDialect().sqlToQuery(whereArg);
      // %, _ and \ are backslash-escaped, then wrapped in %…% for a literal substring match.
      expect(params).toContain('%50\\%\\_x%');
    });
  });

  describe('field encryption', () => {
    it('encrypts encrypted fields on create and decrypts on read', async () => {
      const { randomBytes } = await import('node:crypto');
      const key = randomBytes(32);
      const entity = makeEntity({
        fields: {
          id: field.id(),
          title: field.string({ required: true }),
          secret: field.string({ encrypted: true }),
        },
      });
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const chainable = db._chainable;

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
        encryptionKey: key,
      });

      await repo.create({ title: 'Doc', secret: 'plain-secret' } as any);

      const inserted = chainable.values.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(typeof inserted.secret).toBe('string');
      expect(String(inserted.secret).startsWith('plumbus:enc:v1:')).toBe(true);

      db._rows[0] = { ...db._rows[0], secret: inserted.secret };
      const decrypted = await repo.findById('row-1');
      expect((decrypted as { secret?: string }).secret).toBe('plain-secret');
    });

    it('encrypts encrypted fields on createMany', async () => {
      const { randomBytes } = await import('node:crypto');
      const key = randomBytes(32);
      const entity = makeEntity({
        fields: {
          id: field.id(),
          title: field.string({ required: true }),
          secret: field.string({ encrypted: true }),
        },
      });
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const chainable = db._chainable;

      const repo = createRepository({
        entity,
        table,
        db: db as any,
        auth: makeAuth(),
        encryptionKey: key,
      });

      await repo.createMany([
        { title: 'A', secret: 'one' },
        { title: 'B', secret: 'two' },
      ] as any);

      const inserted = chainable.values.mock.calls[0]?.[0] as Record<string, unknown>[];
      expect(inserted).toHaveLength(2);
      for (const row of inserted) {
        expect(String(row.secret).startsWith('plumbus:enc:v1:')).toBe(true);
      }
    });
  });

  describe('aggregate', () => {
    // Mock db whose select().from().where() chain also supports groupBy/orderBy
    // and resolves to fixed aggregate rows, so we can assert the built projection
    // and numeric coercion of the driver's string results.
    function makeAggregateDb(rows: Record<string, unknown>[]) {
      const chain: any = {
        groupBy: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(rows),
        then: (resolve: (v: unknown) => unknown) => resolve(rows),
      };
      chain.from = vi.fn().mockReturnValue(chain);
      chain.where = vi.fn().mockReturnValue(chain);
      const select = vi.fn().mockReturnValue(chain);
      return { db: { select } as any, chain, select };
    }

    it('builds SUM/COUNT projection, groups, and coerces string results to numbers', async () => {
      const entity = makeEntity({
        name: 'Ledger',
        fields: { id: field.id(), projectId: field.string(), cost: field.decimal() },
      });
      const table = generateDrizzleSchema(entity);
      // postgres-js returns numeric SUM and bigint COUNT as strings.
      const { db, select, chain } = makeAggregateDb([
        { projectId: 'p1', sum_cost: '4.00', count: '2' },
        { projectId: 'p2', sum_cost: '4.25', count: '2' },
      ]);
      const repo = createRepository({ entity, table, db, auth: makeAuth() });

      const result = await repo.aggregate(
        {},
        { groupBy: 'projectId', sum: 'cost', count: true, orderBy: 'sum_cost', orderDir: 'desc' },
      );

      // Projection carries the expected aggregate aliases + group column.
      const projection = select.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(Object.keys(projection).sort()).toEqual(['count', 'projectId', 'sum_cost']);
      expect(chain.groupBy).toHaveBeenCalledTimes(1);
      expect(chain.orderBy).toHaveBeenCalledTimes(1);

      // Driver strings coerced to numbers.
      expect(result).toEqual([
        { projectId: 'p1', sum_cost: 4, count: 2 },
        { projectId: 'p2', sum_cost: 4.25, count: 2 },
      ]);
    });

    it('coerces a NULL SUM (empty scope) to 0', async () => {
      const entity = makeEntity({
        name: 'Ledger',
        fields: { id: field.id(), cost: field.decimal() },
      });
      const table = generateDrizzleSchema(entity);
      const { db } = makeAggregateDb([{ sum_cost: null, count: '0' }]);
      const repo = createRepository({ entity, table, db, auth: makeAuth() });

      const result = await repo.aggregate({}, { sum: 'cost', count: true });
      expect(result).toEqual([{ sum_cost: 0, count: 0 }]);
    });

    it('throws when no group column or aggregate function is requested', async () => {
      const entity = makeEntity();
      const table = generateDrizzleSchema(entity);
      const { db } = makeAggregateDb([]);
      const repo = createRepository({ entity, table, db, auth: makeAuth() });
      await expect(repo.aggregate({}, {})).rejects.toThrow(/at least one/);
    });

    it('rejects aggregating an encrypted field', async () => {
      const entity = makeEntity({
        name: 'Secret',
        fields: {
          id: field.id(),
          amount: field.decimal(),
          token: field.string({ encrypted: true }),
        },
      });
      const table = generateDrizzleSchema(entity);
      const { db } = makeAggregateDb([]);
      const repo = createRepository({
        entity,
        table,
        db,
        auth: makeAuth(),
        encryptionKey: Buffer.alloc(32, 1),
      });
      await expect(repo.aggregate({}, { sum: 'token' })).rejects.toThrow(/encrypted/);
    });
  });

  describe('updateWhere', () => {
    function makeLeaseEntity(): EntityDefinition {
      return makeEntity({
        name: 'LeaseRow',
        fields: {
          id: field.id(),
          title: field.string({ required: true }),
          leaseToken: field.string({ optional: true }),
          revision: field.number({ optional: true }),
        },
      });
    }

    it('updateWhere applies when predicate matches and returns matched:true', async () => {
      const entity = makeLeaseEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      const updated = [{ id: 'row-1', title: 'Updated', leaseToken: null, revision: 1 }];
      db._chainable.returning.mockResolvedValueOnce(updated);
      const repo = createRepository({ entity, table, db: db as any, auth: makeAuth() });

      const result = await repo.updateWhere(
        'row-1',
        { revision: 0 },
        { revision: 1, title: 'Updated' },
      );
      expect(result.matched).toBe(true);
      expect(result.row?.title).toBe('Updated');
    });

    it('updateWhere returns matched:false when predicate loses (concurrent value)', async () => {
      const entity = makeLeaseEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      db._chainable.returning.mockResolvedValueOnce([]);
      const repo = createRepository({ entity, table, db: db as any, auth: makeAuth() });

      const result = await repo.updateWhere('row-1', { revision: 0 }, { revision: 1 });
      expect(result).toEqual({ matched: false, row: null });
    });

    it('updateWhere treats a null predicate value as IS NULL', async () => {
      const entity = makeLeaseEntity();
      const table = generateDrizzleSchema(entity);
      const db = makeMockDb();
      db._chainable.returning.mockResolvedValueOnce([
        { id: 'row-1', title: 'Test', leaseToken: 'tok', revision: 0 },
      ]);
      const repo = createRepository({ entity, table, db: db as any, auth: makeAuth() });

      vi.mocked(isNull).mockClear();
      const result = await repo.updateWhere('row-1', { leaseToken: null }, { leaseToken: 'tok' });
      expect(result.matched).toBe(true);
      expect(isNull).toHaveBeenCalled();
    });
  });
});
