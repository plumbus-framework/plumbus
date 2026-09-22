import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditEvent, AuditWriter } from '../types/audit.js';
import { auditRecords } from './schema.js';

export function createDatabaseAuditWriter(db: PostgresJsDatabase): AuditWriter {
  return {
    async write(event: AuditEvent): Promise<void> {
      await db
        .insert(auditRecords)
        .values({
          id: event.id ?? crypto.randomUUID(),
          actor: event.actor ?? 'anonymous',
          tenantId: event.tenantId ?? null,
          component: event.component,
          action: event.action,
          outcome: event.outcome,
          metadata: event.metadata ?? null,
          maskedFields: event.maskedFields ?? null,
          timestamp: event.timestamp ?? new Date(),
        })
        .onConflictDoNothing({ target: auditRecords.id });
    },
  };
}
