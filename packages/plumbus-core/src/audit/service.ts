import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditService, AuditWriter } from '../types/audit.js';
import type { AuthContext } from '../types/security.js';
import { createDatabaseAuditWriter } from './writer.js';

export interface AuditServiceConfig {
  db: PostgresJsDatabase;
  auth: AuthContext;
  /** Component name for this audit context (e.g. capability name) */
  component?: string;
  writer?: AuditWriter;
}

/**
 * Creates a persistent AuditService that writes records to PostgreSQL.
 */
export function createAuditService(config: AuditServiceConfig): AuditService {
  const { db, auth, component = 'system' } = config;
  const writer = config.writer ?? createDatabaseAuditWriter(db);

  return {
    async record(eventType: string, metadata?: Record<string, unknown>): Promise<void> {
      const outcome = (metadata?.outcome as 'success' | 'failure' | 'denied') ?? 'success';
      const maskedFields = (metadata?._maskedFields as string[]) ?? undefined;

      const storedMetadata = metadata ? { ...metadata } : undefined;
      if (storedMetadata) {
        delete storedMetadata._maskedFields;
      }

      await writer.write({
        actor: auth.userId ?? 'anonymous',
        tenantId: auth.tenantId,
        component,
        action: eventType,
        outcome,
        timestamp: new Date(),
        metadata: storedMetadata,
        maskedFields,
      });
    },
  };
}
