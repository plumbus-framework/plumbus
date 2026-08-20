import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type PgSchema,
  type PgTableFn,
  type PgTableWithColumns,
} from 'drizzle-orm/pg-core';
import type { EntityDefinition } from '../types/entity.js';
import type { FieldDescriptor } from '../types/fields.js';

/**
 * Table constructor signature shared by the unqualified `pgTable` and by
 * `pgSchema(name).table`. Schema placement is the only difference between them.
 */
export type SchemaTableBuilder = PgTableFn<string | undefined>;

/**
 * Suggested schema name for Plumbus's own tenant-local tables (audit records,
 * event outbox, idempotency, dead-letter, flow executions/schedules, job
 * executions). Nothing places tables there by itself — see
 * {@link resolveFrameworkSchema} and {@link tableBuilderFor}.
 */
export const FRAMEWORK_SCHEMA = 'core_plumbus';

/**
 * Environment variable that selects the schema for Plumbus's own tenant-local
 * tables. Unset (the default) keeps them unqualified, exactly where existing
 * databases already have them.
 */
export const FRAMEWORK_SCHEMA_ENV_VAR = 'PLUMBUS_FRAMEWORK_SCHEMA';

/**
 * How generated tables are placed into PostgreSQL schemas.
 *
 * Every field is optional and an omitted/empty option object reproduces the
 * unqualified layout the generator has always produced. The framework supplies
 * the mechanism only: which entities count as platform-owned, and what a
 * package schema is called, are the application's decisions.
 *
 * Resolution order (first match wins):
 *  1. `resolveSchema(entity)`, when it returns a non-empty name
 *  2. `schema`
 *  3. `` `${packageSchemaPrefix}${domain}` `` for an entity whose `domain` is
 *     set and is not listed in `coreDomains`
 *  4. `coreSchema`
 *  5. no schema — the table stays unqualified
 */
export interface SchemaNamespaceOptions {
  /** Fixed schema for every generated table. Overrides domain-driven placement. */
  schema?: string;
  /** Schema for platform-owned tables: entities with no `domain`, or one listed in `coreDomains`. */
  coreSchema?: string;
  /** Prefix joined to a package-owned entity's `domain`, e.g. `'pkg_'` + `'billing'` → `pkg_billing`. */
  packageSchemaPrefix?: string;
  /** Domains that belong to the platform rather than to a package; they land in `coreSchema`. */
  coreDomains?: readonly string[];
  /** Full override. Returning `undefined` falls through to the remaining rules. */
  resolveSchema?: (entity: EntityDefinition) => string | undefined;
}

// One PgSchema instance per schema name. Drizzle keys DDL off the name, but
// drizzle-kit only emits `CREATE SCHEMA` for PgSchema instances it is handed,
// so the instances have to be retrievable after the tables are built.
const pgSchemaCache = new Map<string, PgSchema>();

/**
 * The shared `PgSchema` for `name`, created on first use.
 *
 * Hand these to drizzle-kit alongside the tables (see `declaredPgSchemas`) —
 * without them the generated migration references a schema it never creates.
 */
export function getPgSchema(name: string): PgSchema {
  const existing = pgSchemaCache.get(name);
  if (existing) {
    return existing;
  }
  const created = pgSchema(name);
  pgSchemaCache.set(name, created);
  return created;
}

/**
 * Every `PgSchema` created so far, in first-use order. Empty until a schema
 * name is actually requested, so single-schema deployments stay untouched.
 */
export function declaredPgSchemas(): PgSchema[] {
  return [...pgSchemaCache.values()];
}

/**
 * The table constructor for `schemaName`, or the unqualified `pgTable` when no
 * name is given.
 *
 * This is the one mechanism used for both entity tables and Plumbus's own
 * tenant-local tables:
 *
 * ```ts
 * const table = tableBuilderFor(resolveFrameworkSchema());
 * export const auditRecords = table('audit_records', { ... });
 * ```
 */
export function tableBuilderFor(schemaName?: string): SchemaTableBuilder {
  const name = schemaName?.trim();
  if (!name) {
    return pgTable as SchemaTableBuilder;
  }
  return getPgSchema(name).table as SchemaTableBuilder;
}

/**
 * Schema for Plumbus's own tenant-local tables, read from
 * `PLUMBUS_FRAMEWORK_SCHEMA`. Unset or blank → `undefined`, i.e. the
 * unqualified layout existing databases already have.
 *
 * Read at module load by the framework's table modules, so it is configured
 * through the environment rather than through a setter that would run too late
 * to affect a module-level table definition.
 */
export function resolveFrameworkSchema(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const configured = env[FRAMEWORK_SCHEMA_ENV_VAR]?.trim();
  return configured ? configured : undefined;
}

/**
 * The schema an entity's table belongs in, or `undefined` for an unqualified
 * table. See {@link SchemaNamespaceOptions} for the resolution order.
 */
export function resolveEntitySchemaName(
  entity: EntityDefinition,
  options?: SchemaNamespaceOptions,
): string | undefined {
  if (!options) {
    return undefined;
  }

  const overridden = options.resolveSchema?.(entity)?.trim();
  if (overridden) {
    return overridden;
  }

  const fixed = options.schema?.trim();
  if (fixed) {
    return fixed;
  }

  const domain = toSchemaSegment(entity.domain ?? '');
  const prefix = options.packageSchemaPrefix?.trim();
  if (domain && prefix && !isCoreDomain(domain, options.coreDomains)) {
    return `${prefix}${domain}`;
  }

  return options.coreSchema?.trim() || undefined;
}

function isCoreDomain(domain: string, coreDomains?: readonly string[]): boolean {
  if (!coreDomains) {
    return false;
  }
  return coreDomains.some((candidate) => toSchemaSegment(candidate) === domain);
}

/**
 * Normalize a declared domain into a PostgreSQL schema name segment:
 * snake_case, lowercase, with every other character collapsed to `_`.
 */
function toSchemaSegment(value: string): string {
  return camelToSnake(value.trim())
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Convert an EntityDefinition into a Drizzle pgTable schema.
 * Returns the Drizzle table object ready for use in queries and migrations.
 *
 * Without `options` the table is unqualified, exactly as before. With a schema
 * resolved from `options` it is emitted through `pgSchema(name).table(...)`.
 */
export function generateDrizzleSchema(
  entity: EntityDefinition,
  options?: SchemaNamespaceOptions,
): PgTableWithColumns<any> {
  const tableName = camelToSnake(entity.name);
  const table = tableBuilderFor(resolveEntitySchemaName(entity, options));

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

  // Use 3-arg form: table(name, columns, (table) => indexes)
  return table(tableName, columns, (table) => {
    const indexes: any[] = [];

    if (entity.indexes) {
      for (let i = 0; i < entity.indexes.length; i++) {
        const entry = entity.indexes[i];
        if (!entry) continue;
        const idxFields: string[] = Array.isArray(entry) ? entry : entry.columns;
        const isUnique = Array.isArray(entry) ? false : entry.unique === true;
        if (idxFields.length === 0) continue;
        const idxName = `${tableName}_${idxFields.map(camelToSnake).join('_')}_idx`;

        const cols = idxFields.map((f: string) => (table as any)[f]).filter(Boolean);
        if (cols.length > 0) {
          const [first, ...rest] = cols;
          indexes.push((isUnique ? uniqueIndex(idxName) : index(idxName)).on(first, ...rest));
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
    case 'decimal':
      col = doublePrecision(colName);
      break;
    case 'boolean':
      col = boolean(colName);
      break;
    case 'timestamp':
      col = timestamp(colName, { withTimezone: true });
      // createdAt / updatedAt get defaultNow() so inserts can omit them
      if (colName === 'created_at' || colName === 'updated_at') {
        col = col.defaultNow();
      }
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
 *
 * `options` applies to every entity; per-entity placement still follows the
 * entity's own declared `domain`.
 */
export function generateSchemas(
  entities: EntityDefinition[],
  options?: SchemaNamespaceOptions,
): Map<string, PgTableWithColumns<any>> {
  const schemas = new Map<string, PgTableWithColumns<any>>();
  for (const entity of entities) {
    schemas.set(entity.name, generateDrizzleSchema(entity, options));
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
