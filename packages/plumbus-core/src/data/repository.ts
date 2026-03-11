import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgTableWithColumns } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService } from '../types/audit.js';
import type { Repository } from '../types/context.js';
import type { EntityDefinition } from '../types/entity.js';
import type { FieldClassification } from '../types/enums.js';
import type { AuthContext } from '../types/security.js';

export interface RepositoryOptions {
  entity: EntityDefinition;
  table: PgTableWithColumns<any>;
  db: PostgresJsDatabase;
  auth: AuthContext;
  audit?: AuditService;
  /** Enable soft-delete — sets deletedAt instead of hard delete (default: false) */
  softDelete?: boolean;
}

/**
 * Creates a Repository<T> for an entity that automatically enforces
 * tenant isolation, emits audit records on mutations, and masks
 * sensitive fields in audit logs.
 */
export function createRepository<T = Record<string, unknown>>(
  options: RepositoryOptions,
): Repository<T> {
  const { entity, table, db, auth, audit, softDelete = false } = options;

  const maskedFields = getMaskedFields(entity);
  const isTenantScoped = entity.tenantScoped === true;
  const hasDeletedAt = 'deletedAt' in table;

  function tenantFilter(): SQL | undefined {
    if (!isTenantScoped) return undefined;
    if (!auth.tenantId) {
      throw new Error(`Tenant-scoped entity "${entity.name}" requires auth.tenantId`);
    }
    const tenantCol = (table as any)['tenantId'];
    if (!tenantCol) return undefined;
    return eq(tenantCol, auth.tenantId);
  }

  /** Filter out soft-deleted records when soft-delete is enabled */
  function softDeleteFilter(): SQL | undefined {
    if (!softDelete || !hasDeletedAt) return undefined;
    return isNull((table as any)['deletedAt']);
  }

  function maskData(data: Record<string, unknown>): Record<string, unknown> {
    if (maskedFields.length === 0) return data;
    const masked = { ...data };
    for (const field of maskedFields) {
      if (field in masked) {
        masked[field] = '***';
      }
    }
    return masked;
  }

  async function auditMutation(action: string, data: Record<string, unknown>): Promise<void> {
    if (!audit) return;
    await audit.record(`${entity.name}.${action}`, {
      ...maskData(data),
      _maskedFields: maskedFields,
    });
  }

  return {
    async findById(id: string): Promise<T | null> {
      const conditions: SQL[] = [];
      const idCol = (table as any)['id'];
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);
      const sdf = softDeleteFilter();
      if (sdf) conditions.push(sdf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];

      const rows = await db.select().from(table).where(where).limit(1);

      return (rows[0] as T) ?? null;
    },

    async create(data: Partial<T>): Promise<T> {
      const record: Record<string, unknown> = { ...data };

      // Inject tenantId for tenant-scoped entities
      if (isTenantScoped) {
        if (!auth.tenantId) {
          throw new Error(`Tenant-scoped entity "${entity.name}" requires auth.tenantId`);
        }
        record['tenantId'] = auth.tenantId;
      }

      const rows = await db.insert(table).values(record).returning();
      const created = rows[0] as T;
      await auditMutation('create', record);
      return created;
    },

    async update(id: string, updates: Partial<T>): Promise<T> {
      const conditions: SQL[] = [];
      const idCol = (table as any)['id'];
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];

      const updateData: Record<string, unknown> = {
        ...updates,
        updatedAt: new Date(),
      };

      const rows = await db.update(table).set(updateData).where(where).returning();

      const updated = rows[0] as T;
      await auditMutation('update', { id, ...updateData });
      return updated;
    },

    async delete(id: string): Promise<void> {
      const conditions: SQL[] = [];
      const idCol = (table as any)['id'];
      if (idCol) {
        conditions.push(eq(idCol, id));
      }
      const tf = tenantFilter();
      if (tf) conditions.push(tf);

      const where = conditions.length > 1 ? and(...conditions) : conditions[0];

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

    async findMany(query?: Record<string, unknown>): Promise<T[]> {
      const conditions: SQL[] = [];

      // Apply tenant filter
      const tf = tenantFilter();
      if (tf) conditions.push(tf);

      // Apply soft-delete filter
      const sdf = softDeleteFilter();
      if (sdf) conditions.push(sdf);

      // Apply query filters
      if (query) {
        for (const [key, value] of Object.entries(query)) {
          const col = (table as any)[key];
          if (col) {
            conditions.push(eq(col, value as any));
          }
        }
      }

      const where =
        conditions.length > 1
          ? and(...conditions)
          : conditions.length === 1
            ? conditions[0]
            : undefined;

      const rows = await db.select().from(table).where(where);
      return rows as T[];
    },
  };
}

/**
 * Extract field names that should be masked in audit logs
 * based on field classification or explicit maskedInLogs flag.
 */
function getMaskedFields(entity: EntityDefinition): string[] {
  const masked: string[] = [];
  const sensitiveClassifications = new Set<FieldClassification>([
    'sensitive',
    'highly_sensitive',
    'personal',
  ]);

  for (const [name, descriptor] of Object.entries(entity.fields)) {
    const opts = descriptor.options;
    if (opts.maskedInLogs) {
      masked.push(name);
    } else if (opts.classification && sensitiveClassifications.has(opts.classification)) {
      masked.push(name);
    }
  }
  return masked;
}
