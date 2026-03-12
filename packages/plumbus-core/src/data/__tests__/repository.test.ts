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
});
