import { describe, expect, it, vi } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import {
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
} from '../../errors/data-errors.js';
import { createRepository } from '../repository.js';
import { generateDrizzleSchema } from '../schema-generator.js';

function makeEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name: 'Document',
    fields: { id: field.id(), title: field.string({ required: true }) },
    ...overrides,
  };
}

function makeMockDb() {
  const chainable = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    set: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    select: vi.fn().mockReturnValue(chainable),
    insert: vi.fn().mockReturnValue(chainable),
    update: vi.fn().mockReturnValue(chainable),
    delete: vi.fn().mockReturnValue(chainable),
    _chainable: chainable,
  };
}

describe('repository structured errors', () => {
  it('throws DataForbiddenError without tenantId on tenant-scoped create', async () => {
    const entity = makeEntity({ tenantScoped: true });
    const repo = createRepository({
      entity,
      table: generateDrizzleSchema(entity),
      db: makeMockDb() as never,
      auth: { userId: 'u1', roles: [], scopes: [], provider: 'test' },
    });

    await expect(repo.create({ title: 'x' } as never)).rejects.toBeInstanceOf(DataForbiddenError);
    await expect(repo.create({ title: 'x' } as never)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('throws DataInternalError when RETURNING is empty on create', async () => {
    const entity = makeEntity();
    const db = makeMockDb();
    const repo = createRepository({
      entity,
      table: generateDrizzleSchema(entity),
      db: db as never,
      auth: {
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
        tenantId: 't1',
      },
    });

    await expect(repo.create({ title: 'x' } as never)).rejects.toBeInstanceOf(DataInternalError);
  });

  it('throws DataValidationError when querying encrypted fields with encryption key', async () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        title: field.string({ required: true }),
        secret: field.string({ encrypted: true }),
      },
    });
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const repo = createRepository({
      entity,
      table: generateDrizzleSchema(entity),
      db: makeMockDb() as never,
      auth: {
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
        tenantId: 't1',
      },
      encryptionKey: key,
    });

    await expect(repo.findMany({ secret: 'plain' } as never)).rejects.toBeInstanceOf(
      DataValidationError,
    );
  });

  it('throws DataValidationError when orderBy targets an encrypted field', async () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        title: field.string({ required: true }),
        secret: field.string({ encrypted: true }),
      },
    });
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const repo = createRepository({
      entity,
      table: generateDrizzleSchema(entity),
      db: makeMockDb() as never,
      auth: {
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
        tenantId: 't1',
      },
      encryptionKey: key,
    });

    await expect(repo.findMany({}, { orderBy: 'secret' } as never)).rejects.toBeInstanceOf(
      DataValidationError,
    );
  });

  it('throws DataValidationError when dateFilters targets an encrypted field', async () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        title: field.string({ required: true }),
        secret: field.string({ encrypted: true }),
      },
    });
    const key = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
    const repo = createRepository({
      entity,
      table: generateDrizzleSchema(entity),
      db: makeMockDb() as never,
      auth: {
        userId: 'u1',
        roles: [],
        scopes: [],
        provider: 'test',
        tenantId: 't1',
      },
      encryptionKey: key,
    });

    await expect(
      repo.findMany({}, { dateFilters: { secret: { gte: new Date() } } } as never),
    ).rejects.toBeInstanceOf(DataValidationError);
  });
});
