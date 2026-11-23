// ── Audit Module ──
// Audit trail: Drizzle schema for audit_records table and a service that
// writes structured audit records to PostgreSQL. Used by ctx.audit.
//
// Key exports: createAuditService, bindAuditServiceToTransaction (audit inside a
// transaction on the transaction's connection), auditRecords (Drizzle table)

export { auditRecords } from './schema.js';
export {
  AUDIT_RETRY_DELAYS_MS,
  bindAuditServiceToTransaction,
  createAuditService,
  holdAuditSuccess,
  isTransactionBindableAuditService,
  recordAfterEffects,
  recordAuditBatch,
  registerDerivedAuditService,
  withAuditWriter,
} from './service.js';
export type {
  AuditServiceConfig,
  AuditSuccessHold,
  AuditWriteFailure,
  TransactionAuditBinding,
} from './service.js';
export { AUDIT_WRITE_BATCH_SIZE, createDatabaseAuditWriter } from './writer.js';
