// ── Test Field Validation ──
// Validates record values against entity field descriptors at test-time.
// Catches type mismatches (e.g. float into an integer field) that
// in-memory mocks would otherwise silently accept.

import type { EntityDefinition } from '../types/entity.js';
import type { FieldDescriptor } from '../types/fields.js';

export interface FieldValidationError {
  field: string;
  expected: string;
  actual: string;
  value: unknown;
}

/**
 * Validate a record's values against an entity's field descriptors.
 * Returns an array of validation errors (empty if valid).
 */
export function validateRecord(
  _entityName: string,
  fields: Record<string, FieldDescriptor>,
  record: Record<string, unknown>,
): FieldValidationError[] {
  const errors: FieldValidationError[] = [];

  for (const [fieldName, value] of Object.entries(record)) {
    const descriptor = fields[fieldName];
    if (!descriptor) continue; // extra fields (e.g. tenantId) are fine

    if (value === null || value === undefined) continue; // nullable handling is separate

    const error = validateFieldValue(fieldName, descriptor, value);
    if (error) errors.push(error);
  }

  return errors;
}

function validateFieldValue(
  fieldName: string,
  descriptor: FieldDescriptor,
  value: unknown,
): FieldValidationError | null {
  switch (descriptor.type) {
    case 'id':
    case 'string':
      if (typeof value !== 'string') {
        return { field: fieldName, expected: 'string', actual: typeof value, value };
      }
      return null;

    case 'number':
      if (typeof value !== 'number') {
        return { field: fieldName, expected: 'integer', actual: typeof value, value };
      }
      if (!Number.isInteger(value)) {
        return {
          field: fieldName,
          expected: 'integer',
          actual: 'float',
          value,
        };
      }
      return null;

    case 'decimal':
      if (typeof value !== 'number') {
        return { field: fieldName, expected: 'number', actual: typeof value, value };
      }
      return null;

    case 'boolean':
      if (typeof value !== 'boolean') {
        return { field: fieldName, expected: 'boolean', actual: typeof value, value };
      }
      return null;

    case 'timestamp':
      if (!(value instanceof Date) && typeof value !== 'string') {
        return { field: fieldName, expected: 'Date | string', actual: typeof value, value };
      }
      return null;

    case 'json':
      // json accepts any value
      return null;

    case 'enum':
      if (typeof value !== 'string') {
        return { field: fieldName, expected: `enum(${descriptor.values.join('|')})`, actual: typeof value, value };
      }
      if (!descriptor.values.includes(value)) {
        return {
          field: fieldName,
          expected: `enum(${descriptor.values.join('|')})`,
          actual: `"${value}"`,
          value,
        };
      }
      return null;

    case 'relation':
      if (typeof value !== 'string') {
        return { field: fieldName, expected: 'string (uuid)', actual: typeof value, value };
      }
      return null;

    default:
      return null;
  }
}

/**
 * Build a lookup map from entity name → field descriptors for fast access.
 */
export function buildEntityFieldMap(
  entities: EntityDefinition[],
): Map<string, Record<string, FieldDescriptor>> {
  const map = new Map<string, Record<string, FieldDescriptor>>();
  for (const entity of entities) {
    map.set(entity.name, entity.fields);
  }
  return map;
}
