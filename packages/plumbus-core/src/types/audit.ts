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
}

// ── Audit Service ──
export interface AuditService {
  record(eventType: string, metadata?: Record<string, unknown>): Promise<void>;
}
