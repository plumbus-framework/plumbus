import type { EntityDefinition, EntityIndexDefinition, EntityRetention } from '../types/entity.js';
import type { FieldDescriptor } from '../types/fields.js';
import { deepFreeze } from '../types/deep-freeze.js';
import { throwDefineValidationError } from './validation-error.js';

interface DefineEntityInput {
  name: string;
  description?: string;
  domain?: string;
  tags?: string[];
  owner?: string;

  fields: Record<string, FieldDescriptor>;
  indexes?: Array<string[] | EntityIndexDefinition>;
  retention?: EntityRetention;
  tenantScoped?: boolean;
}

export function defineEntity(config: DefineEntityInput): EntityDefinition {
  if (!config.name) {
    throwDefineValidationError('Entity name is required', { field: 'name' });
  }
  if (!config.fields || Object.keys(config.fields).length === 0) {
    throwDefineValidationError(`Entity "${config.name}": at least one field is required`, {
      field: 'fields',
    });
  }

  // Validate indexes reference existing fields
  if (config.indexes) {
    const fieldNames = new Set(Object.keys(config.fields));
    for (const idx of config.indexes) {
      const cols = Array.isArray(idx) ? idx : idx.columns;
      for (const col of cols) {
        if (!fieldNames.has(col)) {
          throwDefineValidationError(
            `Entity "${config.name}": index references unknown field "${col}"`,
            { field: 'indexes' },
          );
        }
      }
      if (!Array.isArray(idx)) validateIndexMethod(config, idx);
    }
  }

  return deepFreeze({ ...config });
}

/** `using: 'gin'`: exactly one json column, not unique. Any other method name is refused. */
function validateIndexMethod(config: DefineEntityInput, idx: EntityIndexDefinition): void {
  if (idx.using === undefined || idx.using === 'btree') return;
  if (idx.using !== 'gin') {
    throwDefineValidationError(
      `Entity "${config.name}": index method must be 'btree' or 'gin' (received "${String(idx.using)}")`,
      { field: 'indexes' },
    );
  }
  const [column, ...rest] = idx.columns;
  if (!column || rest.length > 0 || config.fields[column]?.type !== 'json') {
    throwDefineValidationError(
      `Entity "${config.name}": a gin index covers exactly one json field (columns: ${JSON.stringify(idx.columns)})`,
      { field: 'indexes' },
    );
  }
  if (idx.unique === true) {
    throwDefineValidationError(`Entity "${config.name}": a gin index cannot be unique`, {
      field: 'indexes',
    });
  }
}
