import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService } from '../types/audit.js';
import type { AuthContext } from '../types/security.js';
import { auditRecords } from './schema.js';

export interface AuditServiceConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  /** Component name for this audit context (e.g. capability name) */
  component?: string;
}

/**
 * Creates a persistent AuditService that writes records to PostgreSQL.
 */
export function createAuditService(config: AuditServiceConfig): AuditService {
  const { db, auth, component = 'system' } = config;

  return {
    async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
      const outcome = (metadata?.outcome as string) ?? 'success';
      const maskedFields = (metadata?._maskedFields as string[]) ?? undefined;

      // Strip internal meta keys from stored metadata
      const storedMetadata = metadata ? { ...metadata } : undefined;
      if (storedMetadata) {
        delete storedMetadata._maskedFields;
      }

      await db.insert(auditRecords).values({
        actor: auth.userId ?? 'anonymous',
        tenantId: auth.tenantId ?? null,
        component,
        action: eventType,
        outcome,
        metadata: storedMetadata ?? null,
        maskedFields: maskedFields ?? null,
      });
    },
  };
}
