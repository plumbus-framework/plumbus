import {
  and,
  asc,
  avg,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  or,
  sql,
  sum,
  type SQL,
} from 'drizzle-orm';
import { getTableColumns } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import { resolveSelectedFields } from './projection.js';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService } from '../types/audit.js';
import type {
  AggregateOptions,
  AggregateRow,
  AggregateValue,
  ConditionalUpdateResult,
  FrameworkRepository,
  Page,
  PageOptions,
  QueryFilters,
  QueryOptions,
  SetWriteOptions,
  SetWriteResult,
  UpdateOptions,
} from '../types/context.js';
import {
  decodeKeysetCursor,
  defaultReadCeilingPolicy,
  encodeKeysetCursor,
  type KeysetKey,
  planReadBound,
  type ReadCeilingOperation,
  type ReadCeilingPolicy,
  resolveKeysetKeys,
} from './read-ceiling.js';
import type { EntityDefinition } from '../types/entity.js';
import { ErrorHints } from '../errors/hints.js';
import {
  DataForbiddenError,
  DataInternalError,
  DataValidationError,
} from '../errors/data-errors.js';
import type { AuthContext } from '../types/security.js';
import {
  decryptFieldValue,
  encryptFieldValue,
  getEncryptedFields,
  isEncryptedValue,
} from './field-encryption.js';
import {
  getAuditSilentFields,
  getMaskedFields,
  maskSensitiveValues,
  AUDIT_MASK_TOKEN,
} from './mask-fields.js';
import { recordAuditBatch } from '../audit/index.js';

/**
 * Column types whose `in` list is sent as one typed array parameter. Other types (enums named by
 * the host, json, timestamps) keep one parameter per value, as before.
 */
const ARRAY_PARAM_TYPE =
  /^(uuid|text|integer|bigint|smallint|real|double precision|boolean|numeric(\(\d+(, ?\d+)?\))?|varchar(\(\d+\))?|character varying(\(\d+\))?)$/;

/** `in` values per column that a summary audit row lists before it gives only their number. */
const SUMMARY_IN_LIST_MAX = 1000;

export interface RepositoryOptions {
  entity: EntityDefinition;
  table: PgTableWithColumns<any>;
  db: PostgresJsDatabase;
  auth: AuthContext;
  audit?: AuditService;
  /** Enable soft-delete — sets deletedAt instead of hard delete (default: false) */
  softDelete?: boolean;
  /** Bypass tenant-scope filtering for cross-tenant admin access (default: false) */
  bypassTenantScope?: boolean;
  /** AES-256-GCM key for `encrypted: true` string fields (from PLUMBUS_ENCRYPTION_KEY) */
  encryptionKey?: Buffer;
  /**
   * Rows one read may return without `{ unbounded: true }`, and what happens past it.
   * Default: {@link defaultReadCeilingPolicy} (1000 rows, `warn`). `EntityRegistry` passes the
   * host's policy (`data.readCeiling` / `data.readCeilingMode`).
   */
  readCeiling?: ReadCeilingPolicy;
}

/**
 * Creates a Repository<T> for an entity that automatically enforces
 * tenant isolation, emits audit records on mutations, and masks
 * sensitive fields in audit logs.
 */
export function createRepository<
  T = Record<string, unknown>,
  TCreate extends Record<string, unknown> = Record<string, any>,
  TUpdate extends Record<string, unknown> = Record<string, any>,
>(options: RepositoryOptions): FrameworkRepository<T, TCreate, TUpdate> {
  const {
    entity,
    table,
    db,
    auth,
    audit,
    softDelete = false,
    bypassTenantScope = false,
    encryptionKey,
  } = options;
  const readCeiling = options.readCeiling ?? defaultReadCeilingPolicy();

  const maskedFields = getMaskedFields(entity);
  const auditSilentFields = new Set(getAuditSilentFields(entity));
  /** True when the update changes nothing but `auditSilent` fields (plus the framework's `updatedAt`). */
  function isAuditSilentUpdate(updates: Record<string, unknown>): boolean {
    if (auditSilentFields.size === 0) return false;
    const changed = Object.keys(updates).filter((key) => key !== 'updatedAt');
    return changed.length > 0 && changed.every((key) => auditSilentFields.has(key));
  }
  const encryptedFields = getEncryptedFields(entity);
  const isTenantScoped = entity.tenantScoped === true;
  const hasDeletedAt = 'deletedAt' in table;

  async function assertTenantContext(operation: string): Promise<void> {
    if (!isTenantScoped || bypassTenantScope) return;
    if (auth.tenantId) return;
    if (audit) {
      await audit.record(`${entity.name}.tenant_denied`, {
        operation,
        actor: auth.userId,
        reason: 'missing_tenant_context',
        // A refusal: recorded as `denied`, so it survives the rollback of the transaction
        // that attempted the access (success records of a rolled-back transaction are dropped).
        outcome: 'denied',
      });
    }
    throw new DataForbiddenError(
      `${ErrorHints.tenantContextRequired} Tenant-scoped entity "${entity.name}" requires auth.tenantId`,
      { entity: entity.name, operation },
    );
  }

  function tenantFilter(): SQL | undefined {
    if (!isTenantScoped || bypassTenantScope) return undefined;
    if (!auth.tenantId) {
      // assertTenantContext() should run before tenantFilter(); defensive only.
      throw new DataForbiddenError(
        `${ErrorHints.tenantContextRequired} Tenant-scoped entity "${entity.name}" requires auth.tenantId`,
        { entity: entity.name },
      );
    }
    const tenantCol = (table as any).tenantId;
    if (!tenantCol) return undefined;
    return eq(tenantCol, auth.tenantId);
  }

  /** Filter out soft-deleted records when soft-delete is enabled */
  function softDeleteFilter(): SQL | undefined {
    if (!softDelete || !hasDeletedAt) return undefined;
    return isNull((table as any).deletedAt);
  }

  function maskData(data: Record<string, unknown>): Record<string, unknown> {
    if (maskedFields.length === 0) return data;
    return maskSensitiveValues(data, maskedFields, AUDIT_MASK_TOKEN) as Record<string, unknown>;
  }

  function assertQueryableField(fieldName: string, operation: string): void {
    if (!encryptionKey || encryptedFields.length === 0) return;
    if (!encryptedFields.includes(fieldName)) return;
    throw new DataValidationError(`Cannot query encrypted field "${fieldName}"`, {
      entity: entity.name,
      field: fieldName,
      operation,
    });
  }

  function collectQueryFieldNames(query?: Partial<T>, options?: QueryOptions): string[] {
    const names: string[] = [];
    if (query) {
      for (const key of Object.keys(query)) {
        names.push(key);
      }
    }
    if (options?.in) {
      for (const key of Object.keys(options.in)) {
        names.push(key);
      }
    }
    if (options?.notEq) {
      for (const key of Object.keys(options.notEq)) {
        names.push(key);
      }
    }
    if (options?.search?.columns) {
      for (const col of options.search.columns) {
        names.push(col);
      }
    }
    if (options?.dateFilters) {
      for (const key of Object.keys(options.dateFilters)) {
        names.push(key);
      }
    }
    if (options?.contains) {
      for (const key of Object.keys(options.contains)) {
        names.push(key);
      }
    }
    if (options?.orderBy) {
      const specs =
        typeof options.orderBy === 'string' ? [{ column: options.orderBy }] : options.orderBy;
      for (const spec of specs) {
        names.push(spec.column);
      }
    }
    return names;
  }

  function assertQueryableFields(
    query?: Partial<T>,
    options?: QueryOptions,
    operation = 'findMany',
  ): void {
    for (const fieldName of collectQueryFieldNames(query, options)) {
      assertQueryableField(fieldName, operation);
    }
  }

  function encryptRecordFields(record: Record<string, unknown>): Record<string, unknown> {
    if (!encryptionKey || encryptedFields.length === 0) return record;
    const encrypted = { ...record };
    for (const field of encryptedFields) {
      const value = encrypted[field];
      if (typeof value === 'string' && value.length > 0 && !isEncryptedValue(value)) {
        encrypted[field] = encryptFieldValue(value, encryptionKey);
      }
    }
    return encrypted;
  }

  function decryptRecordFields(record: Record<string, unknown>): Record<string, unknown> {
    if (encryptedFields.length === 0) return record;
    const decrypted = { ...record };
    for (const field of encryptedFields) {
      const value = decrypted[field];
      if (typeof value === 'string' && isEncryptedValue(value)) {
        decrypted[field] = encryptionKey ? decryptFieldValue(value, encryptionKey) : value;
      }
    }
    return decrypted;
  }

  function decryptRow(row: T | undefined): T | null {
    if (!row) return null;
    return decryptRecordFields(row as Record<string, unknown>) as T;
  }

  async function auditMutation(action: string, data: Record<string, unknown>): Promise<void> {
    if (!audit) return;
    await audit.record(`${entity.name}.${action}`, {
      ...maskData(data),
      _maskedFields: maskedFields,
    });
  }

  /**
   * `col = ANY($1::type[])`: one array parameter however long the list, so no list crosses
   * PostgreSQL's 65,535 bind-parameter limit and every length shares one statement text. Each
   * value goes through the column's own driver mapping first, as `inArray` would have done.
   */
  function anyOf(column: any, values: ReadonlyArray<string | number>): SQL {
    const sqlType = typeof column.getSQLType === 'function' ? String(column.getSQLType()) : '';
    if (!ARRAY_PARAM_TYPE.test(sqlType)) return inArray(column, values as any[]);
    const encoded = values.map((value) =>
      typeof column.mapToDriverValue === 'function' ? column.mapToDriverValue(value) : value,
    );
    return sql`${column} = ANY(${sql.param(encoded)}::${sql.raw(sqlType)}[])`;
  }

  /** `col @> $1::jsonb` for a json field; any other field is refused. */
  function containsCondition(fieldName: string, value: unknown): SQL {
    const descriptor = entity.fields[fieldName];
    const column = (table as any)[fieldName];
    if (!descriptor || descriptor.type !== 'json' || !column) {
      throw new DataValidationError(
        `contains on "${entity.name}": "${fieldName}" is not a json field of the entity`,
        { entity: entity.name, field: fieldName, operation: 'contains' },
      );
    }
    if (value === undefined) {
      throw new DataValidationError(
        `contains on "${entity.name}": no value given for "${fieldName}"`,
        { entity: entity.name, field: fieldName, operation: 'contains' },
      );
    }
    return sql`${column} @> ${JSON.stringify(value)}::jsonb`;
  }

  function buildConditions(query?: Partial<T>, options?: QueryOptions): SQL[] {
    assertQueryableFields(query, options);
    const conditions: SQL[] = [];
    const tf = tenantFilter();
    if (tf) conditions.push(tf);
    const sdf = softDeleteFilter();
    if (sdf) conditions.push(sdf);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        const c = (table as any)[k];
        if (c) conditions.push(eq(c, v as any));
      }
    }
    if (options?.dateFilters) {
      for (const [k, r] of Object.entries(options.dateFilters)) {
        const c = (table as any)[k];
        if (!c) continue;
        if (r.gte) conditions.push(gte(c, r.gte));
        if (r.lte) conditions.push(lte(c, r.lte));
      }
    }
    if (options?.in) {
      for (const [k, vals] of Object.entries(options.in)) {
        const c = (table as any)[k];
        if (!c) continue;
        // An empty allow-list allows nothing. Dropping the filter instead (as earlier
        // releases did) turned "rows for none of these ids" into "every row".
        conditions.push(vals.length ? anyOf(c, vals) : sql`false`);
      }
    }
    if (options?.contains) {
      for (const [k, value] of Object.entries(options.contains)) {
        conditions.push(containsCondition(k, value));
      }
    }
    if (options?.notEq) {
      for (const [k, v] of Object.entries(options.notEq)) {
        const c = (table as any)[k];
        if (c) conditions.push(ne(c, v as any));
      }
    }
    if (options?.search?.term) {
      const cols = options.search.columns.map((c) => (table as any)[c]).filter(Boolean);
      if (cols.length) {
        // Escape LIKE metacharacters so a user term matches literally. Postgres ILIKE
        // treats % and _ as wildcards and \ as the default escape char; without this a
        // term like "50%" or "a_b" would match far more rows (and diverges from the
        // literal-substring semantics of the in-memory test repository).
        const escaped = options.search.term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const like = `%${escaped}%`;
        const ors = cols.map((c: any) => ilike(c, like));
        conditions.push((ors.length === 1 ? ors[0] : or(...ors)) as SQL);
      }
    }
    return conditions;
  }

  /**
   * The statement shape every set-based write shares: the filters (tenant scope, soft delete,
   * the caller's query and filters), and the bounded id subquery that picks at most `limit`
   * of the matching rows in a stable order. The outer statement repeats the filters, so a row
   * changed by another transaction since the subquery read it is re-checked before it is
   * written (PostgreSQL re-evaluates the outer WHERE on the newest row version).
   */
  function planSetWrite(
    operation: 'deleteMany' | 'updateMany',
    query: Partial<T> | undefined,
    setOptions: SetWriteOptions,
  ): { limit: number; conditions: SQL[]; inner: any } {
    const limit = setOptions?.limit;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new DataValidationError(`${operation} needs limit: a whole number of at least 1`, {
        entity: entity.name,
        operation,
        field: 'limit',
      });
    }
    if (
      setOptions.audit !== undefined &&
      setOptions.audit !== 'per-row' &&
      setOptions.audit !== 'summary'
    ) {
      throw new DataValidationError(`${operation} audit must be 'per-row' or 'summary'`, {
        entity: entity.name,
        operation,
        field: 'audit',
      });
    }
    const conditions = buildConditions(query, filtersOf(setOptions));
    const idColumn = (table as any).id;
    let inner: any = db.select({ id: idColumn }).from(table).where(combine(conditions));
    inner = setOptions.orderBy
      ? applyOrder(inner, { orderBy: setOptions.orderBy, orderDir: setOptions.orderDir ?? 'asc' })
      : inner.orderBy(asc(idColumn));
    inner = inner.limit(limit);
    return { limit, conditions, inner };
  }

  /** The filter of a set-based write as a summary audit row records it, masked. */
  function auditedFilter(query: Partial<T> | undefined, setOptions: SetWriteOptions) {
    const maskedSet = new Set(maskedFields);
    const maskValue = (fieldName: string, value: unknown) =>
      maskedSet.has(fieldName) ? AUDIT_MASK_TOKEN : value;
    const maskEach = (record: Record<string, unknown> | undefined) =>
      record
        ? Object.fromEntries(Object.entries(record).map(([k, v]) => [k, maskValue(k, v)]))
        : undefined;
    const inLists = setOptions.in
      ? Object.fromEntries(
          Object.entries(setOptions.in).map(([k, vals]) => {
            const shown = maskedSet.has(k) ? vals.map(() => AUDIT_MASK_TOKEN) : vals;
            return [
              k,
              shown.length > SUMMARY_IN_LIST_MAX
                ? {
                    values: shown.slice(0, SUMMARY_IN_LIST_MAX),
                    total: shown.length,
                    truncated: true,
                  }
                : shown,
            ];
          }),
        )
      : undefined;
    const search = setOptions.search
      ? {
          columns: setOptions.search.columns,
          term: setOptions.search.columns.some((c) => maskedSet.has(c))
            ? AUDIT_MASK_TOKEN
            : setOptions.search.term,
        }
      : undefined;
    return Object.fromEntries(
      Object.entries({
        where: query ? maskData(query as Record<string, unknown>) : undefined,
        in: inLists,
        notEq: maskEach(setOptions.notEq),
        dateFilters: maskEach(setOptions.dateFilters as Record<string, unknown> | undefined),
        contains: maskEach(setOptions.contains),
        search,
        orderBy: setOptions.orderBy,
      }).filter(([, v]) => v !== undefined),
    );
  }

  /**
   * Audit rows of a set-based write: per row (the rows a loop of single writes leaves) or one
   * summary row. Nothing when no row changed.
   */
  async function auditSetWrite(
    action: 'delete' | 'update',
    ids: string[],
    query: Partial<T> | undefined,
    setOptions: SetWriteOptions,
    limit: number,
    updateData?: Record<string, unknown>,
  ): Promise<void> {
    if (!audit || ids.length === 0) return;
    if ((setOptions.audit ?? 'per-row') === 'per-row') {
      const values = updateData ? maskData(updateData) : undefined;
      await recordAuditBatch(
        audit,
        ids.map((id) => ({
          eventType: `${entity.name}.${action}`,
          // Exactly what `delete(id)` / `update(id, …)` record for one row.
          metadata: { id, ...values, _maskedFields: maskedFields },
        })),
      );
      return;
    }
    await audit.record(`${entity.name}.${action}Many`, {
      count: ids.length,
      limit,
      filter: auditedFilter(query, setOptions),
      ...(updateData ? { values: maskData(updateData) } : {}),
      _maskedFields: maskedFields,
    });
  }

  function combine(conds: SQL[]): SQL | undefined {
    return conds.length > 1 ? and(...conds) : conds[0];
  }

  function applyOrder(qb: any, options?: QueryOptions): any {
    if (!options?.orderBy) return qb;
    const spec =
      typeof options.orderBy === 'string'
        ? [{ column: options.orderBy, dir: options.orderDir }]
        : options.orderBy;
    const cols = spec
      .map((s) => {
        const c = (table as any)[s.column];
        if (!c) return null;
        return (s.dir ?? options.orderDir) === 'asc' ? asc(c) : desc(c);
      })
      .filter(Boolean) as SQL[];
    return cols.length ? qb.orderBy(...cols) : qb;
  }

  /** Only the WHERE filters of a call (no order, limit or aggregate keys). */
  function filtersOf(options?: QueryFilters): QueryOptions | undefined {
    return options
      ? {
          dateFilters: options.dateFilters,
          search: options.search,
          in: options.in,
          notEq: options.notEq,
          contains: options.contains,
        }
      : undefined;
  }

  /** A `findPage` sort key's column: it must exist and be queryable (never encrypted). */
  function keysetColumn(key: KeysetKey): any {
    assertQueryableField(key.column, 'findPage');
    const column = (table as any)[key.column];
    if (!column) {
      throw new DataValidationError(
        `findPage on "${entity.name}": "${key.column}" is not a column of the entity`,
        { entity: entity.name, field: key.column, operation: 'findPage' },
      );
    }
    return column;
  }

  /**
   * Rows strictly after the cursor row in the order `keys`:
   * (k1 > v1) OR (k1 = v1 AND k2 > v2) OR … — `<` for a descending key.
   */
  function keysetAfter(
    keys: KeysetKey[],
    columns: any[],
    values: Array<string | number | boolean | Date>,
  ): SQL {
    const branches: SQL[] = keys.map((key, i) => {
      const parts: SQL[] = [];
      for (let j = 0; j < i; j++) parts.push(eq(columns[j], values[j]));
      parts.push(key.dir === 'asc' ? gt(columns[i], values[i]) : lt(columns[i], values[i]));
      return (parts.length === 1 ? parts[0] : and(...parts)) as SQL;
    });
    return (branches.length === 1 ? branches[0] : or(...branches)) as SQL;
  }

  /** Shared by findMany and findManyFields; `fields` narrows the SQL columns. */
  async function queryMany(
    query: Partial<T> | undefined,
    options: QueryOptions | undefined,
    fields?: readonly unknown[],
    operation: ReadCeilingOperation = 'findMany',
  ): Promise<Record<string, unknown>[]> {
    await assertTenantContext('findMany');
    const bound = planReadBound(readCeiling, entity.name, operation, options);
    const columns = getTableColumns(table);
    const selected = resolveSelectedFields(fields, new Set(Object.keys(columns)));
    const selection = selected
      ? Object.fromEntries(selected.map((name) => [name, columns[name]]))
      : undefined;
    const where = combine(buildConditions(query, options));
    let qb = (selection ? db.select(selection as any) : db.select()).from(table).where(where);
    qb = applyOrder(qb, options);
    if (bound.sqlLimit !== undefined) {
      qb = qb.limit(bound.sqlLimit) as typeof qb;
    }
    if (options?.offset != null) {
      qb = qb.offset(Math.max(0, options.offset)) as typeof qb;
    }
    const result = await qb;
    const rows = Array.isArray(result) ? result : [];
    bound.check(rows.length);
    return rows.flatMap((row) => {
      const decrypted = decryptRow(row as T);
      return decrypted ? [decrypted] : [];
    });
  }

  return {
    async findById(id: string): Promise<T | null> {
      await assertTenantContext('findById');
      const conditions: SQL[] = [];
      const idCol = (table as any).id;
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);
      const sdf = softDeleteFilter();
      if (sdf) conditions.push(sdf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];

      const rows = await db.select().from(table).where(where).limit(1);

      return decryptRow(rows[0] as T | undefined);
    },

    async create(data: TCreate): Promise<T> {
      await assertTenantContext('create');
      const record: Record<string, unknown> = encryptRecordFields({ ...data });

      // Inject tenantId for tenant-scoped entities
      if (isTenantScoped && !bypassTenantScope && auth.tenantId) {
        record.tenantId = auth.tenantId;
      }

      const rows = await db.insert(table).values(record).returning();
      const created = decryptRow(rows[0] as T | undefined);
      if (!created) {
        throw new DataInternalError(`Failed to create "${entity.name}" record`, {
          entity: entity.name,
        });
      }
      await auditMutation('create', record);
      return created;
    },

    async createMany(records: TCreate[]): Promise<T[]> {
      if (records.length === 0) return [];
      await assertTenantContext('createMany');

      const prepared = records.map((data) => {
        const record: Record<string, unknown> = encryptRecordFields({ ...data });
        if (isTenantScoped && !bypassTenantScope && auth.tenantId) {
          record.tenantId = auth.tenantId;
        }
        return record;
      });

      const rows = await db.insert(table).values(prepared).returning();

      // One summary audit row per batch instead of N per-row audits.
      await auditMutation('createMany', {
        count: prepared.length,
        sample: maskData(prepared[0] ?? {}),
      });

      return rows.map((row) => {
        const decrypted = decryptRow(row as T | undefined);
        if (!decrypted) {
          throw new DataInternalError(`Failed to create "${entity.name}" record in batch`, {
            entity: entity.name,
          });
        }
        return decrypted;
      }) as T[];
    },

    async update(id: string, updates: TUpdate, updateOptions?: UpdateOptions): Promise<any> {
      await assertTenantContext('update');
      const conditions: SQL[] = [];
      const idCol = (table as any).id;
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];
      if (!where) {
        throw new DataInternalError(
          `Refusing to update "${entity.name}" without a WHERE predicate (no id and no tenant filter)`,
          { entity: entity.name, id },
        );
      }

      const updateData: Record<string, unknown> = encryptRecordFields({
        ...updates,
        updatedAt: new Date(),
      });

      // `returning: false` reads back only the id, to tell a missing row; the row's other
      // (possibly wide) columns are not read.
      const quiet = updateOptions?.returning === false;
      const rows = quiet
        ? await db
            .update(table)
            .set(updateData)
            .where(where)
            .returning({ id: (table as any).id })
        : await db.update(table).set(updateData).where(where).returning();

      const updated = decryptRow(rows[0] as T | undefined);
      if (!updated) {
        throw new DataInternalError(`Failed to update "${entity.name}" record ${id}`, {
          entity: entity.name,
          id,
        });
      }
      if (!isAuditSilentUpdate(updates as Record<string, unknown>)) {
        await auditMutation('update', { id, ...updateData });
      }
      return quiet ? undefined : updated;
    },

    async updateWhere(
      id: string,
      predicate: Record<string, unknown>,
      updates: Record<string, unknown>,
    ): Promise<ConditionalUpdateResult<T>> {
      await assertTenantContext('updateWhere');
      const conditions: SQL[] = [];
      const idCol = (table as any).id;
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);
      // Equality predicate; a `null` value maps to SQL `IS NULL` (drizzle `eq`
      // never renders `col = NULL`). Unknown columns are ignored.
      for (const [k, v] of Object.entries(predicate)) {
        const c = (table as any)[k];
        if (!c) continue;
        conditions.push(v === null ? isNull(c) : eq(c, v as any));
      }

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];
      if (!where) {
        throw new DataInternalError(
          `Refusing to updateWhere "${entity.name}" without a WHERE predicate (no id and no tenant filter)`,
          { entity: entity.name, id },
        );
      }

      const updateData: Record<string, unknown> = encryptRecordFields({
        ...updates,
        updatedAt: new Date(),
      });

      const rows = await db.update(table).set(updateData).where(where).returning();
      const updated = decryptRow(rows[0] as T | undefined);
      if (!updated) {
        return { matched: false, row: null };
      }
      if (!isAuditSilentUpdate(updates as Record<string, unknown>)) {
        await auditMutation('update', { id, ...updateData });
      }
      return { matched: true, row: updated };
    },

    async delete(id: string): Promise<void> {
      await assertTenantContext('delete');
      const conditions: SQL[] = [];
      const idCol = (table as any).id;
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];
      if (!where) {
        throw new DataInternalError(
          `Refusing to delete "${entity.name}" without a WHERE predicate (no id and no tenant filter)`,
          { entity: entity.name, id },
        );
      }

      if (softDelete && hasDeletedAt) {
        await db
          .update(table)
          .set({ deletedAt: new Date() } as any)
          .where(where);
      } else {
        await db.delete(table).where(where);
      }
      await auditMutation('delete', { id });
    },

    async deleteMany(query: Partial<T> | undefined, setOptions: SetWriteOptions) {
      await assertTenantContext('deleteMany');
      const { limit, conditions, inner } = planSetWrite('deleteMany', query, setOptions);
      const outer = and(inArray((table as any).id, inner), ...conditions) as SQL;
      const rows =
        softDelete && hasDeletedAt
          ? await db
              .update(table)
              .set({ deletedAt: new Date() } as any)
              .where(outer)
              .returning({ id: (table as any).id })
          : await db
              .delete(table)
              .where(outer)
              .returning({ id: (table as any).id });
      const ids = (Array.isArray(rows) ? rows : []).map((row) => String((row as any).id));
      await auditSetWrite('delete', ids, query, setOptions, limit);
      return { count: ids.length, ids } satisfies SetWriteResult;
    },

    async updateMany(
      query: Partial<T> | undefined,
      values: TUpdate,
      setOptions: SetWriteOptions,
    ): Promise<SetWriteResult> {
      await assertTenantContext('updateMany');
      const changes = { ...(values as Record<string, unknown>) };
      const columns = getTableColumns(table);
      for (const key of Object.keys(changes)) {
        if (key === 'id' || key === 'tenantId' || !columns[key]) {
          throw new DataValidationError(`updateMany on "${entity.name}" cannot set "${key}"`, {
            entity: entity.name,
            field: key,
            operation: 'updateMany',
          });
        }
      }
      if (Object.keys(changes).length === 0) {
        throw new DataValidationError(`updateMany on "${entity.name}" needs at least one value`, {
          entity: entity.name,
          operation: 'updateMany',
        });
      }
      const { limit, conditions, inner } = planSetWrite('updateMany', query, setOptions);
      const updateData: Record<string, unknown> = encryptRecordFields({
        ...changes,
        updatedAt: new Date(),
      });
      const rows = await db
        .update(table)
        .set(updateData)
        .where(and(inArray((table as any).id, inner), ...conditions) as SQL)
        .returning({ id: (table as any).id });
      const ids = (Array.isArray(rows) ? rows : []).map((row) => String((row as any).id));
      if (!isAuditSilentUpdate(changes)) {
        await auditSetWrite('update', ids, query, setOptions, limit, updateData);
      }
      return { count: ids.length, ids };
    },

    findMany(query?: Partial<T>, options?: QueryOptions): Promise<T[]> {
      return queryMany(query, options) as Promise<T[]>;
    },

    findManyFields<K extends keyof T>(
      query: Partial<T> | undefined,
      fields: readonly K[],
      options?: QueryOptions,
    ): Promise<Pick<T, K>[]> {
      return queryMany(query, options, fields ?? null, 'findManyFields') as Promise<Pick<T, K>[]>;
    },

    async exists(query?: Partial<T>, options?: QueryFilters): Promise<boolean> {
      await assertTenantContext('exists');
      const where = combine(buildConditions(query, filtersOf(options)));
      const rows = await db.select({ one: sql<number>`1` }).from(table).where(where).limit(1);
      return Array.isArray(rows) && rows.length > 0;
    },

    async findPage(query: Partial<T> | undefined, options: PageOptions): Promise<Page<T>> {
      await assertTenantContext('findPage');
      if (!Number.isInteger(options?.limit) || options.limit < 1) {
        throw new DataValidationError('findPage needs limit: a whole number of at least 1', {
          entity: entity.name,
          operation: 'findPage',
          field: 'limit',
        });
      }
      const bound = planReadBound(readCeiling, entity.name, 'findPage', { limit: options.limit });
      const pageSize = bound.sqlLimit ?? options.limit;
      const keys = resolveKeysetKeys(options.orderBy, options.orderDir);
      const keyColumns = keys.map((key) => keysetColumn(key));
      const conditions = buildConditions(query, filtersOf(options));
      if (options.after !== undefined) {
        const values = decodeKeysetCursor(entity.name, keys, options.after);
        conditions.push(keysetAfter(keys, keyColumns, values));
      }
      const order = keys.map((key, i) =>
        key.dir === 'asc' ? asc(keyColumns[i]) : desc(keyColumns[i]),
      );
      const result = await db
        .select()
        .from(table)
        .where(combine(conditions))
        .orderBy(...order)
        .limit(pageSize + 1);
      const rows = (Array.isArray(result) ? result : []) as Record<string, unknown>[];
      const more = rows.length > pageSize;
      const pageRows = more ? rows.slice(0, pageSize) : rows;
      const last = pageRows[pageRows.length - 1];
      return {
        rows: pageRows.flatMap((row) => {
          const decrypted = decryptRow(row as T);
          return decrypted ? [decrypted] : [];
        }),
        nextCursor: more && last ? encodeKeysetCursor(entity.name, keys, last) : null,
      };
    },

    async count(query?: Partial<T>, options?: QueryFilters): Promise<number> {
      await assertTenantContext('count');
      const where = combine(buildConditions(query, filtersOf(options)));
      const res = await db.select({ count: count() }).from(table).where(where);
      return Number(res[0]?.count ?? 0);
    },

    async aggregate(query?: Partial<T>, options?: AggregateOptions): Promise<AggregateRow[]> {
      await assertTenantContext('aggregate');

      // WHERE reuses the shared builder (tenant scope, soft-delete, encrypted-
      // field guard, and the query/dateFilters/search/in/notEq filters). Only
      // the filter subset is forwarded — an aggregate `orderBy` may reference
      // aggregate aliases (e.g. `sum_cost`) that are not table columns, so it
      // must not flow into the WHERE/field-validation pass.
      const where = combine(buildConditions(query, filtersOf(options)));

      const selection: Record<string, any> = {};
      // `sum_*`/`count`/`countDistinct_*` are always numeric; `sum_*` additionally
      // coerces a NULL (empty) result to 0. `avg_*` is numeric-or-null. `min_*`/
      // `max_*` and group columns pass through untouched.
      const numericAliases = new Set<string>();
      const sumAliases = new Set<string>();

      const groupByExprs: SQL[] = [];
      for (const g of asColumnList(options?.groupBy)) {
        assertQueryableField(g, 'aggregate');
        const col = (table as any)[g];
        if (!col) continue;
        selection[g] = col;
        groupByExprs.push(col);
      }

      const addAgg = (
        cols: string[],
        fn: (c: any) => SQL,
        prefix: string,
        numeric: boolean,
        zeroFill = false,
      ) => {
        for (const c of cols) {
          assertQueryableField(c, 'aggregate');
          const col = (table as any)[c];
          if (!col) continue;
          const alias = `${prefix}_${c}`;
          selection[alias] = fn(col);
          if (numeric) numericAliases.add(alias);
          if (zeroFill) sumAliases.add(alias);
        }
      };
      addAgg(asColumnList(options?.sum), (c) => sum(c) as SQL, 'sum', true, true);
      addAgg(asColumnList(options?.avg), (c) => avg(c) as SQL, 'avg', true);
      addAgg(asColumnList(options?.min), (c) => min(c) as SQL, 'min', false);
      addAgg(asColumnList(options?.max), (c) => max(c) as SQL, 'max', false);
      addAgg(
        asColumnList(options?.countDistinct),
        (c) => countDistinct(c) as SQL,
        'countDistinct',
        true,
      );
      if (options?.count) {
        selection.count = count();
        numericAliases.add('count');
      }

      if (Object.keys(selection).length === 0) {
        throw new DataValidationError(
          `aggregate() on "${entity.name}" requires at least one group column or aggregate function`,
          { entity: entity.name, operation: 'aggregate' },
        );
      }

      let qb: any = db.select(selection).from(table).where(where);
      if (groupByExprs.length) qb = qb.groupBy(...groupByExprs);

      if (options?.orderBy) {
        const specs =
          typeof options.orderBy === 'string'
            ? [{ column: options.orderBy, dir: options.orderDir }]
            : options.orderBy;
        const orderExprs = specs
          .map((s) => {
            const expr = (selection[s.column] ?? (table as any)[s.column]) as SQL | undefined;
            if (!expr) return null;
            return (s.dir ?? options.orderDir) === 'asc' ? asc(expr) : desc(expr);
          })
          .filter(Boolean) as SQL[];
        if (orderExprs.length) qb = qb.orderBy(...orderExprs);
      }

      const bound = planReadBound(readCeiling, entity.name, 'aggregate', options);
      if (bound.sqlLimit !== undefined) {
        qb = qb.limit(bound.sqlLimit);
      }

      const result = await qb;
      const rows = Array.isArray(result) ? result : [];
      bound.check(rows.length);
      return rows.map((row) => {
        const out: AggregateRow = {};
        for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
          if (sumAliases.has(k)) {
            out[k] = v == null ? 0 : Number(v);
          } else if (numericAliases.has(k)) {
            out[k] = v == null ? null : Number(v);
          } else {
            out[k] = v as AggregateValue;
          }
        }
        return out;
      });
    },
  };
}

/** Normalize a string | string[] | undefined column spec to a string[]. */
function asColumnList(value?: string | string[]): string[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

export { getMaskedFields } from './mask-fields.js';
