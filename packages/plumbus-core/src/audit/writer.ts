import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { AuditEvent, AuditWriter } from '../types/audit.js';
import { auditRecords } from './schema.js';

/** Rows per INSERT of `writeMany` (9 parameters a row, far under the 65,535 limit). */
export const AUDIT_WRITE_BATCH_SIZE = 1000;

function rowOf(event: AuditEvent) {
  return {
    id: event.id ?? crypto.randomUUID(),
    actor: event.actor ?? 'anonymous',
    tenantId: event.tenantId ?? null,
    component: event.component,
    action: event.action,
    outcome: event.outcome,
    metadata: event.metadata ?? null,
    maskedFields: event.maskedFields ?? null,
    timestamp: event.timestamp ?? new Date(),
  };
}

export function createDatabaseAuditWriter(db: PostgresJsDatabase): AuditWriter {
  return {
    async write(event: AuditEvent): Promise<void> {
      await db
        .insert(auditRecords)
        .values(rowOf(event))
        .onConflictDoNothing({ target: auditRecords.id });
    },
    async writeMany(events: AuditEvent[]): Promise<void> {
      for (let start = 0; start < events.length; start += AUDIT_WRITE_BATCH_SIZE) {
        await db
          .insert(auditRecords)
          .values(events.slice(start, start + AUDIT_WRITE_BATCH_SIZE).map(rowOf))
          .onConflictDoNothing({ target: auditRecords.id });
      }
    },
  };
}
