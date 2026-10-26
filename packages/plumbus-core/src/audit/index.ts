// ── Audit Module ──
// Audit trail: Drizzle schema for audit_records table and a service that
// writes structured audit records to PostgreSQL. Used by ctx.audit.
//
// Key exports: createAuditService, bindAuditServiceToTransaction (audit inside a
// transaction on the transaction's connection), auditRecords (Drizzle table)

export { auditRecords } from './schema.js';
export { bindAuditServiceToTransaction, createAuditService } from './service.js';
export type { AuditServiceConfig, TransactionAuditBinding } from './service.js';
export { createDatabaseAuditWriter } from './writer.js';
