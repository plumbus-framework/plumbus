// ── Audit Module ──
// Audit trail: Drizzle schema for audit_records table and a service that
// writes structured audit records to PostgreSQL. Used by ctx.audit.
//
// Key exports: createAuditService, auditRecords (Drizzle table)

export { auditRecords } from './schema.js';
export { createAuditService } from './service.js';
export type { AuditServiceConfig } from './service.js';
