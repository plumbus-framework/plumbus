import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { field } from '../../fields/index.js';
import type { EntityDefinition } from '../../types/entity.js';
import { generateDrizzleSchema, generateSchemas } from '../schema-generator.js';

function makeEntity(overrides: Partial<EntityDefinition> = {}): EntityDefinition {
  return {
    name: 'TestUser',
    fields: {
      id: field.id(),
      name: field.string({ required: true }),
      email: field.string({ required: true, unique: true }),
    },
    ...overrides,
  };
}

describe('generateDrizzleSchema', () => {
  it('creates a table with the snake_case entity name', () => {
    const table = generateDrizzleSchema(makeEntity());
    expect(getTableName(table)).toBe('test_user');
  });

  it('maps field types to correct column types', () => {
    const entity = makeEntity({
      name: 'AllTypes',
      fields: {
        id: field.id(),
        label: field.string(),
        count: field.number(),
        active: field.boolean(),
        createdAt: field.timestamp(),
        meta: field.json(),
        status: field.enum(['active', 'disabled']),
        orgId: field.relation({ entity: 'Org', type: 'many-to-one' }),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);

    expect(cols.id).toBeDefined();
    expect(cols.label).toBeDefined();
    expect(cols.count).toBeDefined();
    expect(cols.active).toBeDefined();
    expect(cols.createdAt).toBeDefined();
    expect(cols.meta).toBeDefined();
    expect(cols.status).toBeDefined();
    expect(cols.orgId).toBeDefined();
  });

  it('auto-adds createdAt and updatedAt when not in fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        name: field.string(),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);

    expect(cols.createdAt).toBeDefined();
    expect(cols.updatedAt).toBeDefined();
  });

  it('does not duplicate createdAt if already in fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        createdAt: field.timestamp(),
      },
    });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.createdAt).toBeDefined();
    // updatedAt still auto-added
    expect(cols.updatedAt).toBeDefined();
  });

  it('adds tenantId column for tenantScoped entities', () => {
    const entity = makeEntity({ tenantScoped: true });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.tenantId).toBeDefined();
  });

  it('does not add tenantId for non-tenantScoped entities', () => {
    const entity = makeEntity({ tenantScoped: false });
    const table = generateDrizzleSchema(entity);
    const cols = getTableColumns(table);
    expect(cols.tenantId).toBeUndefined();
  });

  it('handles empty indexes gracefully', () => {
    const entity = makeEntity({ indexes: [] });
    const table = generateDrizzleSchema(entity);
    expect(table).toBeDefined();
  });

  it('creates indexes for defined fields', () => {
    const entity = makeEntity({
      fields: {
        id: field.id(),
        name: field.string(),
        email: field.string(),
      },
      indexes: [['name'], ['name', 'email']],
    });
    const table = generateDrizzleSchema(entity);
    expect(table).toBeDefined();
  });
});

describe('generateSchemas', () => {
  it('generates schemas for multiple entities', () => {
    const entities = [makeEntity({ name: 'User' }), makeEntity({ name: 'Project' })];
    const schemas = generateSchemas(entities);
    expect(schemas.size).toBe(2);
    expect(schemas.has('User')).toBe(true);
    expect(schemas.has('Project')).toBe(true);
  });
});
