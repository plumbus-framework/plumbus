import { describe, expect, it } from 'vitest';
import { field } from '../index.js';

describe('field constructors', () => {
  it('creates an id field', () => {
    const f = field.id();
    expect(f.type).toBe('id');
    expect(f.options).toEqual({});
  });

  it('creates a string field with options', () => {
    const f = field.string({ required: true, unique: true, classification: 'personal' });
    expect(f.type).toBe('string');
    expect(f.options.required).toBe(true);
    expect(f.options.unique).toBe(true);
    expect(f.options.classification).toBe('personal');
  });

  it('creates a number field', () => {
    const f = field.number({ nullable: true });
    expect(f.type).toBe('number');
    expect(f.options.nullable).toBe(true);
  });

  it('creates a boolean field with default', () => {
    const f = field.boolean({ default: true });
    expect(f.type).toBe('boolean');
    expect(f.options.default).toBe(true);
  });

  it('creates a timestamp field', () => {
    const f = field.timestamp({ maskedInLogs: true });
    expect(f.type).toBe('timestamp');
    expect(f.options.maskedInLogs).toBe(true);
  });

  it('creates a json field', () => {
    const f = field.json({ encrypted: true, classification: 'highly_sensitive' });
    expect(f.type).toBe('json');
    expect(f.options.encrypted).toBe(true);
    expect(f.options.classification).toBe('highly_sensitive');
  });

  it('creates an enum field', () => {
    const f = field.enum(['active', 'inactive', 'pending']);
    expect(f.type).toBe('enum');
    expect(f.values).toEqual(['active', 'inactive', 'pending']);
  });

  it('throws on empty enum values', () => {
    expect(() => field.enum([])).toThrow('at least one value');
  });

  it('creates a relation field', () => {
    const f = field.relation({ entity: 'Organization', type: 'many-to-one' });
    expect(f.type).toBe('relation');
    expect(f.entity).toBe('Organization');
    expect(f.relationType).toBe('many-to-one');
  });

  it('throws on relation without entity', () => {
    expect(() => field.relation({ entity: '', type: 'one-to-one' })).toThrow('entity name');
  });
});
