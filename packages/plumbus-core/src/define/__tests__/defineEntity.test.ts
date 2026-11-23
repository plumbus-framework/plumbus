import { describe, expect, it } from 'vitest';
import { field } from '../../fields/index.js';
import { defineEntity } from '../defineEntity.js';

describe('defineEntity', () => {
  const validConfig = () => ({
    name: 'User',
    fields: {
      id: field.id(),
      email: field.string({ required: true, unique: true, classification: 'personal' as const }),
      name: field.string({ required: true }),
      active: field.boolean({ default: true }),
    },
  });

  it('creates a valid entity definition', () => {
    const entity = defineEntity(validConfig());
    expect(entity.name).toBe('User');
    expect(Object.keys(entity.fields)).toEqual(['id', 'email', 'name', 'active']);
  });

  it('freezes the returned definition', () => {
    const entity = defineEntity(validConfig());
    expect(Object.isFrozen(entity)).toBe(true);
  });

  it('accepts optional fields', () => {
    const entity = defineEntity({
      ...validConfig(),
      description: 'Application user',
      domain: 'identity',
      tags: ['core'],
      owner: 'team-auth',
      indexes: [['email'], ['name', 'active']],
      retention: { duration: '365d' },
      tenantScoped: true,
    });
    expect(entity.indexes).toEqual([['email'], ['name', 'active']]);
    expect(entity.tenantScoped).toBe(true);
  });

  it('throws if name is missing', () => {
    expect(() => defineEntity({ ...validConfig(), name: '' })).toThrow('name is required');
  });

  it('throws if fields is empty', () => {
    expect(() => defineEntity({ ...validConfig(), fields: {} })).toThrow(
      'at least one field is required',
    );
  });

  it('throws if index references unknown field', () => {
    expect(() =>
      defineEntity({
        ...validConfig(),
        indexes: [['nonexistent']],
      }),
    ).toThrow('index references unknown field "nonexistent"');
  });

  it('accepts object index form and validates its columns', () => {
    const entity = defineEntity({
      ...validConfig(),
      indexes: [{ columns: ['name'], unique: true }],
    });
    expect(entity.indexes).toEqual([{ columns: ['name'], unique: true }]);

    expect(() =>
      defineEntity({
        ...validConfig(),
        indexes: [{ columns: ['nope'] }],
      }),
    ).toThrow('index references unknown field "nope"');
  });
});

describe('gin indexes (json containment)', () => {
  it('accepts one json field and refuses any other shape', () => {
    const fields = { id: field.id(), tags: field.json(), title: field.string() };
    expect(() =>
      defineEntity({ name: 'Tagged', fields, indexes: [{ columns: ['tags'], using: 'gin' }] }),
    ).not.toThrow();
    for (const index of [
      { columns: ['title'], using: 'gin' as const },
      { columns: ['tags', 'title'], using: 'gin' as const },
      { columns: ['tags'], using: 'gin' as const, unique: true },
      { columns: ['tags'], using: 'spgist' as never },
    ]) {
      expect(() => defineEntity({ name: 'Tagged', fields, indexes: [index] })).toThrow(/index/);
    }
  });
});

describe('indexes beyond fields: framework columns, order, expressions, partial, operator classes', () => {
  const fields = { id: field.id(), displayName: field.string(), state: field.string() };

  it('accepts framework columns, sort options, expressions with a name, a predicate and an opclass', () => {
    expect(() =>
      defineEntity({
        name: 'Account',
        tenantScoped: true,
        fields,
        indexes: [
          {
            columns: ['tenantId', 'createdAt', 'id'],
            columnOptions: { createdAt: { order: 'desc', nulls: 'last' } },
          },
          { columns: [], expressions: ['lower(display_name)'], name: 'account_lower_name_idx' },
          { columns: ['state'], where: "state = 'open'" },
          {
            columns: ['displayName'],
            columnOptions: { displayName: { opclass: 'gin_trgm_ops' } },
            using: 'gin',
          },
          { columns: ['updatedAt'], using: 'brin' },
        ],
      }),
    ).not.toThrow();
  });

  it('refuses unknown columns, tenantId on an untenanted entity, unnamed expressions and second statements', () => {
    for (const index of [
      { columns: ['tenantId'] },
      { columns: ['nope'] },
      { columns: ['state'], columnOptions: { email: { order: 'desc' } } },
      { columns: [], expressions: ['lower(display_name)'] },
      { columns: [] },
      { columns: ['state'], where: "state = 'x'; DROP TABLE account" },
      { columns: [], expressions: [''], name: 'x_idx' },
      { columns: ['state'], columnOptions: { state: { order: 'sideways' as never } } },
      { columns: ['state'], columnOptions: { state: { opclass: 'x; drop' } } },
      { columns: ['state'], name: 'Bad-Name' },
    ]) {
      expect(() => defineEntity({ name: 'Account', fields, indexes: [index as never] })).toThrow(
        /index/,
      );
    }
  });
});
