import {
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uuid,
    type PgTableWithColumns,
} from 'drizzle-orm/pg-core';
import type { EntityDefinition } from '../types/entity.js';
import type { FieldDescriptor } from '../types/fields.js';

/**
 * Convert an EntityDefinition into a Drizzle pgTable schema.
 * Returns the Drizzle table object ready for use in queries and migrations.
 */
export function generateDrizzleSchema(entity: EntityDefinition): PgTableWithColumns<any> {
  const tableName = camelToSnake(entity.name);

  // Build columns using stand-alone constructors
  const columns: Record<string, any> = {};

  for (const [fieldName, descriptor] of Object.entries(entity.fields)) {
    const colName = camelToSnake(fieldName);
    columns[fieldName] = mapFieldToColumn(colName, descriptor);
  }

  // Auto-add tenantId for tenant-scoped entities
  if (entity.tenantScoped && !entity.fields.tenantId) {
    columns.tenantId = text('tenant_id').notNull();
  }

  // Auto-add timestamps
  if (!entity.fields.createdAt) {
    columns.createdAt = timestamp('created_at', { withTimezone: true }).defaultNow().notNull();
  }
  if (!entity.fields.updatedAt) {
    columns.updatedAt = timestamp('updated_at', { withTimezone: true }).defaultNow().notNull();
  }

  // Use 3-arg form: pgTable(name, columns, (table) => indexes)
  return pgTable(tableName, columns, (table) => {
    const indexes: any[] = [];

    if (entity.indexes) {
      for (let i = 0; i < entity.indexes.length; i++) {
        const idxFields: string[] | undefined = entity.indexes[i];
        if (!idxFields) continue;
        const idxName = `${tableName}_${idxFields.map(camelToSnake).join('_')}_idx`;

        const cols = idxFields.map((f: string) => (table as any)[f]).filter(Boolean);
        if (cols.length > 0) {
          const [first, ...rest] = cols;
          indexes.push(index(idxName).on(first, ...rest));
        }
      }
    }

    // Auto-index tenantId for tenant-scoped entities
    if (entity.tenantScoped) {
      const tenantCol = (table as any).tenantId;
      if (tenantCol) {
        const tenantIdx = `${tableName}_tenant_id_idx`;
        indexes.push(index(tenantIdx).on(tenantCol));
      }
    }

    return indexes;
  }) as PgTableWithColumns<any>;
}

function mapFieldToColumn(colName: string, descriptor: FieldDescriptor): any {
  let col: any;

  switch (descriptor.type) {
    case 'id':
      col = uuid(colName).defaultRandom().primaryKey();
      break;
    case 'string':
      col = text(colName);
      break;
    case 'number':
      col = integer(colName);
      break;
    case 'boolean':
      col = boolean(colName);
      break;
    case 'timestamp':
      col = timestamp(colName, { withTimezone: true });
      break;
    case 'json':
      col = jsonb(colName);
      break;
    case 'enum':
      col = text(colName);
      break;
    case 'relation':
      col = uuid(colName);
      break;
    default:
      col = text(colName);
  }

  // Apply constraints from options
  const opts = descriptor.options;

  if (descriptor.type !== 'id') {
    if (opts.required && !opts.nullable) {
      col = col.notNull();
    }
    if (opts.default !== undefined) {
      col = col.default(opts.default);
    }
    if (opts.unique) {
      col = col.unique();
    }
  }

  return col;
}

/**
 * Generate schemas for multiple entities at once.
 */
export function generateSchemas(
  entities: EntityDefinition[],
): Map<string, PgTableWithColumns<any>> {
  const schemas = new Map<string, PgTableWithColumns<any>>();
  for (const entity of entities) {
    schemas.set(entity.name, generateDrizzleSchema(entity));
  }
  return schemas;
}

/**
 * Convert camelCase to snake_case for database naming.
 */
function camelToSnake(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}
