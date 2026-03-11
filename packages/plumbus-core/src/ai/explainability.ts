// ── AI Explainability ──
// Record per AI invocation: prompt used, retrieval sources, response metadata, validation results
// Links to audit trail for traceability

import type { AuditService } from "../types/audit.js";
import type { AIDocument } from "../types/context.js";
import type { TokenUsage } from "./provider.js";

// ── AI Invocation Record ──
export interface AIInvocationRecord {
  id: string;
  timestamp: Date;
  operation: "generate" | "extract" | "classify" | "retrieve";
  promptName?: string;
  model?: string;
  input: Record<string, unknown>;
  output: unknown;
  usage?: TokenUsage;
  /** RAG sources used for context */
  retrievalSources?: AIDocument[];
  /** Validation result */
  validation?: {
    passed: boolean;
    attempts: number;
    errors?: string[];
  };
  /** Security warnings raised */
  securityWarnings?: string[];
  /** Actor/tenant context */
  actor?: string;
  tenantId?: string;
  latencyMs: number;
}

// ── Explainability Tracker ──
export interface AIExplainabilityTracker {
  record(invocation: Omit<AIInvocationRecord, "id" | "timestamp">): AIInvocationRecord;
  getRecords(): AIInvocationRecord[];
  getByPrompt(promptName: string): AIInvocationRecord[];
}

export interface ExplainabilityConfig {
  /** Audit service to link invocations to audit trail */
  audit?: AuditService;
  /** Actor identifier for audit records */
  actor?: string;
}

export function createExplainabilityTracker(config?: ExplainabilityConfig): AIExplainabilityTracker {
  const records: AIInvocationRecord[] = [];

  return {
    record(invocation) {
      const record: AIInvocationRecord = {
        ...invocation,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      };
      records.push(record);

      // Link to audit trail if configured
      if (config?.audit) {
        config.audit.record(`ai.${invocation.operation}`, {
          actor: invocation.actor ?? config.actor ?? "system",
          promptName: invocation.promptName,
          model: invocation.model,
          usage: invocation.usage,
          retrievalSourceCount: invocation.retrievalSources?.length ?? 0,
          validationAttempts: invocation.validation?.attempts,
          securityWarningCount: invocation.securityWarnings?.length ?? 0,
          latencyMs: invocation.latencyMs,
          outcome: invocation.validation?.passed !== false ? "success" : "failure",
        });
      }

      return record;
    },

    getRecords() {
      return [...records];
    },

    getByPrompt(promptName: string) {
      return records.filter((r) => r.promptName === promptName);
    },
  };
}
