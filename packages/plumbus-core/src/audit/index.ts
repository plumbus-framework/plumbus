// ── Audit Module ──
// Audit trail: Drizzle schema for audit_records table and a service that
// writes structured audit records to PostgreSQL. Used by ctx.audit.
//
// Key exports: createAuditService, bindAuditServiceToTransaction (audit inside a
// transaction on the transaction's connection), createAuditOutbox / runWithAuditOutbox
// (records of work on another database held in that work's transaction, delivered after
// commit; relayAuditOutbox delivers leftovers), auditRecords (Drizzle table)

export { auditRecords } from './schema.js';
export {
  AUDIT_OUTBOX_GRACE_MS,
  AUDIT_OUTBOX_TABLE,
  auditOutboxAvailable,
  auditOutboxDdl,
  auditOutboxTable,
  createAuditOutbox,
  relayAuditOutbox,
  runWithAuditOutbox,
} from './outbox.js';
export type {
  AuditOutbox,
  AuditOutboxFlushResult,
  RelayAuditOutboxOptions,
  RelayAuditOutboxResult,
} from './outbox.js';
export {
  AUDIT_RETRY_DELAYS_MS,
  bindAuditServiceToTransaction,
  createAuditService,
  holdAuditSuccess,
  isTransactionBindableAuditService,
  recordAfterEffects,
  recordAuditBatch,
} from './service.js';
export type {
  AuditServiceConfig,
  AuditSuccessHold,
  AuditWriteFailure,
  TransactionAuditBinding,
} from './service.js';
export { AUDIT_WRITE_BATCH_SIZE, createDatabaseAuditWriter } from './writer.js';
