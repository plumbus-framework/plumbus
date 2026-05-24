import type { EntityDefinition, EntityRetention } from '../types/entity.js';
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
  indexes?: string[][];
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
      for (const col of idx) {
        if (!fieldNames.has(col)) {
          throwDefineValidationError(
            `Entity "${config.name}": index references unknown field "${col}"`,
            { field: 'indexes' },
          );
        }
      }
    }
  }

  return deepFreeze({ ...config });
}
