// ── Audit Record ──
export interface AuditRecord {
  id: string;
  actor: string;
  tenantId?: string;
  timestamp: Date;
  component: string;
  action: string;
  outcome: "success" | "failure" | "denied";
  metadata?: Record<string, unknown>;
  maskedFields?: string[];
}

// ── Audit Service ──
export interface AuditService {
  record(
    eventType: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
}
