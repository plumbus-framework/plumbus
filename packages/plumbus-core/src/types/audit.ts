// ── Audit Record ──
export interface AuditRecord {
  id: string;
  actor: string;
  tenantId?: string;
  timestamp: Date;
  component: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  metadata?: Record<string, unknown>;
  maskedFields?: string[];
}

export interface AuditEvent {
  /** Stable id for idempotent write retries. */
  id?: string;
  actor?: string;
  tenantId?: string;
  component: string;
  action: string;
  outcome: 'success' | 'failure' | 'denied';
  timestamp?: Date;
  metadata?: Record<string, unknown>;
  maskedFields?: string[];
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
  /**
   * Write several events at once (the database writer: one multi-row INSERT per batch).
   * Optional: a writer without it is called once per event.
   */
  writeMany?(events: AuditEvent[]): Promise<void>;
}

/** One record of {@link AuditService.recordMany}. */
export interface AuditBatchEntry {
  eventType: string;
  metadata?: Record<string, unknown>;
}

// ── Audit Service ──
export interface AuditService {
  record(eventType: string, metadata?: Record<string, unknown>): Promise<void>;
  /**
   * Record several events in as few writes as the store allows, with the same meaning as one
   * `record` call per entry (each entry keeps its own outcome). Optional: callers fall back to
   * `record` per entry (`recordAuditBatch`). The framework's services implement it.
   */
  recordMany?(entries: AuditBatchEntry[]): Promise<void>;
}
