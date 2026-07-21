import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditEvent, AuditWriter } from '../types/audit.js';
import { auditRecords } from './schema.js';

export function createDatabaseAuditWriter(db: PostgresJsDatabase): AuditWriter {
  return {
    async write(event: AuditEvent): Promise<void> {
      await db.insert(auditRecords).values({
        actor: event.actor ?? 'anonymous',
        tenantId: event.tenantId ?? null,
        component: event.component,
        action: event.action,
        outcome: event.outcome,
        metadata: event.metadata ?? null,
        maskedFields: event.maskedFields ?? null,
      });
    },
  };
}
