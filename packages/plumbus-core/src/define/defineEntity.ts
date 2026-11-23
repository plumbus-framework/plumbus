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

  if (config.indexes) {
    for (const idx of config.indexes) validateIndex(config, idx);
  }

  return deepFreeze({ ...config });
}

/** Framework columns every generated table has (`tenantId` only on tenant-scoped entities). */
function frameworkColumns(config: DefineEntityInput): Set<string> {
  const columns = new Set(['id', 'createdAt', 'updatedAt']);
  if (config.tenantScoped) columns.add('tenantId');
  return columns;
}

const SQL_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const INDEX_METHODS = new Set(['btree', 'gin', 'gist', 'hash', 'brin']);

/** A fragment of SQL the app wrote: one expression or predicate, never a second statement. */
function assertSqlFragment(config: DefineEntityInput, what: string, text: unknown): void {
  if (typeof text !== 'string' || text.trim().length === 0 || text.includes(';')) {
    throwDefineValidationError(
      `Entity "${config.name}": index ${what} must be one non-empty SQL expression without ';'`,
      { field: 'indexes' },
    );
  }
}

/**
 * An index: keys that are fields or framework columns, optional expressions, a known method,
 * an optional partial predicate. `gin` on one json field without an operator class keeps its
 * historic meaning (`jsonb_path_ops`, cannot be unique).
 */
function validateIndex(config: DefineEntityInput, entry: string[] | EntityIndexDefinition): void {
  const def: EntityIndexDefinition = Array.isArray(entry) ? { columns: entry } : entry;
  const known = new Set([...Object.keys(config.fields), ...frameworkColumns(config)]);
  if (!Array.isArray(def.columns)) {
    throwDefineValidationError(`Entity "${config.name}": an index needs columns (may be [])`, {
      field: 'indexes',
    });
  }
  for (const column of def.columns) {
    if (typeof column !== 'string' || !known.has(column)) {
      throwDefineValidationError(
        `Entity "${config.name}": index references unknown field "${String(column)}"`,
        { field: 'indexes' },
      );
    }
  }
  for (const [column, key] of Object.entries(def.columnOptions ?? {})) {
    if (!def.columns.includes(column)) {
      throwDefineValidationError(
        `Entity "${config.name}": columnOptions names "${column}", which is not among the index columns`,
        { field: 'indexes' },
      );
    }
    if (key.order !== undefined && key.order !== 'asc' && key.order !== 'desc') {
      throwDefineValidationError(`Entity "${config.name}": index order must be 'asc' or 'desc'`, {
        field: 'indexes',
      });
    }
    if (key.nulls !== undefined && key.nulls !== 'first' && key.nulls !== 'last') {
      throwDefineValidationError(`Entity "${config.name}": index nulls must be 'first' or 'last'`, {
        field: 'indexes',
      });
    }
    if (key.opclass !== undefined && !SQL_IDENTIFIER.test(key.opclass)) {
      throwDefineValidationError(
        `Entity "${config.name}": index opclass must be an operator class name (received "${key.opclass}")`,
        { field: 'indexes' },
      );
    }
  }
  const expressions = def.expressions ?? [];
  for (const expression of expressions) assertSqlFragment(config, 'expression', expression);
  if (def.columns.length === 0 && expressions.length === 0) {
    throwDefineValidationError(`Entity "${config.name}": an index needs columns or expressions`, {
      field: 'indexes',
    });
  }
  if (def.where !== undefined) assertSqlFragment(config, 'where', def.where);
  if (def.name !== undefined && !SQL_IDENTIFIER.test(def.name)) {
    throwDefineValidationError(
      `Entity "${config.name}": index name must be a lowercase SQL identifier of at most 63 characters`,
      { field: 'indexes' },
    );
  }
  if (expressions.length > 0 && def.name === undefined) {
    throwDefineValidationError(`Entity "${config.name}": an index with expressions needs a name`, {
      field: 'indexes',
    });
  }
  const method = def.using ?? 'btree';
  if (!INDEX_METHODS.has(method)) {
    throwDefineValidationError(
      `Entity "${config.name}": index method must be one of btree, gin, gist, hash, brin (received "${String(def.using)}")`,
      { field: 'indexes' },
    );
  }
  if (method === 'gin') validateGin(config, def);
}

/**
 * `gin`: either the historic form (exactly one json field, `jsonb_path_ops`, never unique) or
 * keys and expressions with an explicit operator class (e.g. trigram `gin_trgm_ops`).
 */
function validateGin(config: DefineEntityInput, def: EntityIndexDefinition): void {
  if (def.unique === true) {
    throwDefineValidationError(`Entity "${config.name}": a gin index cannot be unique`, {
      field: 'indexes',
    });
  }
  const keys = def.columns.map((column) => ({ column, ...def.columnOptions?.[column] }));
  const explicit =
    keys.some((key) => key.opclass !== undefined) || (def.expressions ?? []).length > 0;
  if (explicit) return;
  const [first, ...rest] = keys;
  if (!first || rest.length > 0 || config.fields[first.column]?.type !== 'json') {
    throwDefineValidationError(
      `Entity "${config.name}": a gin index covers exactly one json field unless it names an operator class (columns: ${JSON.stringify(def.columns)})`,
      { field: 'indexes' },
    );
  }
}
