// ── Explanation System ──
// Attach explanation metadata to: flow branching decisions, authorization decisions,
// AI invocations, governance warnings. Store alongside audit records. Queryable.

import type { AuditService } from '../types/audit.js';

// ── Explanation Types ──
export type ExplanationType = 'authorization' | 'flow-branch' | 'ai-invocation' | 'governance';

export interface ExplanationRecord {
  id: string;
  timestamp: Date;
  type: ExplanationType;
  component: string;
  decision: string;
  reasoning: string;
  inputs: Record<string, unknown>;
  outcome: string;
  actor?: string;
  tenantId?: string;
  metadata?: Record<string, unknown>;
}

// ── Authorization Explanation ──
export interface AuthorizationExplanation {
  capability: string;
  actor: string;
  tenantId?: string;
  decision: 'allow' | 'deny';
  matchedRoles?: string[];
  matchedScopes?: string[];
  deniedReason?: string;
}

// ── Flow Branch Explanation ──
export interface FlowBranchExplanation {
  flowName: string;
  executionId: string;
  stepName: string;
  condition: string;
  evaluatedTo: boolean;
  branchTaken: string;
  stateSnapshot?: Record<string, unknown>;
}

// ── AI Invocation Explanation ──
export interface AIInvocationExplanation {
  promptName?: string;
  operation: string;
  model?: string;
  retrievalSources?: Array<{ source: string; score: number }>;
  validationResult?: { passed: boolean; attempts: number };
  tokenUsage?: { input: number; output: number };
}

// ── Governance Explanation ──
export interface GovernanceExplanation {
  rule: string;
  severity: string;
  affectedComponent: string;
  overridden: boolean;
  overrideJustification?: string;
}

// ── Explanation Tracker ──
export interface ExplanationTracker {
  recordAuthorization(explanation: AuthorizationExplanation): ExplanationRecord;
  recordFlowBranch(explanation: FlowBranchExplanation): ExplanationRecord;
  recordAIInvocation(explanation: AIInvocationExplanation): ExplanationRecord;
  recordGovernance(explanation: GovernanceExplanation): ExplanationRecord;
  getRecords(filter?: ExplanationFilter): ExplanationRecord[];
  getByComponent(component: string): ExplanationRecord[];
  getByType(type: ExplanationType): ExplanationRecord[];
}

export interface ExplanationFilter {
  type?: ExplanationType;
  component?: string;
  actor?: string;
  tenantId?: string;
  since?: Date;
  until?: Date;
}

export interface ExplanationTrackerConfig {
  audit?: AuditService;
  actor?: string;
  tenantId?: string;
}

export function createExplanationTracker(config?: ExplanationTrackerConfig): ExplanationTracker {
  const records: ExplanationRecord[] = [];

  function addRecord(
    type: ExplanationType,
    component: string,
    decision: string,
    reasoning: string,
    inputs: Record<string, unknown>,
    outcome: string,
    metadata?: Record<string, unknown>,
  ): ExplanationRecord {
    const record: ExplanationRecord = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      type,
      component,
      decision,
      reasoning,
      inputs,
      outcome,
      actor: config?.actor,
      tenantId: config?.tenantId,
      metadata,
    };
    records.push(record);

    if (config?.audit) {
      config.audit.record(`explanation.${type}`, {
        explanationId: record.id,
        component,
        decision,
        outcome,
      });
    }

    return record;
  }

  function matchesFilter(record: ExplanationRecord, filter: ExplanationFilter): boolean {
    if (filter.type && record.type !== filter.type) return false;
    if (filter.component && record.component !== filter.component) return false;
    if (filter.actor && record.actor !== filter.actor) return false;
    if (filter.tenantId && record.tenantId !== filter.tenantId) return false;
    if (filter.since && record.timestamp < filter.since) return false;
    if (filter.until && record.timestamp > filter.until) return false;
    return true;
  }

  return {
    recordAuthorization(explanation) {
      return addRecord(
        'authorization',
        `capability:${explanation.capability}`,
        explanation.decision,
        explanation.decision === 'allow'
          ? `Matched roles: [${explanation.matchedRoles?.join(', ') ?? 'none'}], scopes: [${explanation.matchedScopes?.join(', ') ?? 'none'}]`
          : `Denied: ${explanation.deniedReason ?? 'no matching roles or scopes'}`,
        {
          actor: explanation.actor,
          tenantId: explanation.tenantId,
          capability: explanation.capability,
        },
        explanation.decision,
        {
          matchedRoles: explanation.matchedRoles,
          matchedScopes: explanation.matchedScopes,
        },
      );
    },

    recordFlowBranch(explanation) {
      return addRecord(
        'flow-branch',
        `flow:${explanation.flowName}`,
        `branch:${explanation.branchTaken}`,
        `Condition "${explanation.condition}" evaluated to ${explanation.evaluatedTo} — took branch "${explanation.branchTaken}"`,
        {
          flowName: explanation.flowName,
          executionId: explanation.executionId,
          stepName: explanation.stepName,
          condition: explanation.condition,
        },
        explanation.branchTaken,
        { stateSnapshot: explanation.stateSnapshot },
      );
    },

    recordAIInvocation(explanation) {
      return addRecord(
        'ai-invocation',
        explanation.promptName ? `prompt:${explanation.promptName}` : `ai:${explanation.operation}`,
        explanation.operation,
        `AI ${explanation.operation}${explanation.model ? ` using ${explanation.model}` : ''}${explanation.retrievalSources?.length ? ` with ${explanation.retrievalSources.length} retrieval sources` : ''}`,
        {
          promptName: explanation.promptName,
          operation: explanation.operation,
          model: explanation.model,
        },
        explanation.validationResult?.passed ? 'validated' : 'unvalidated',
        {
          retrievalSources: explanation.retrievalSources,
          tokenUsage: explanation.tokenUsage,
          validationResult: explanation.validationResult,
        },
      );
    },

    recordGovernance(explanation) {
      return addRecord(
        'governance',
        explanation.affectedComponent,
        explanation.overridden ? 'overridden' : explanation.severity,
        explanation.overridden
          ? `Rule "${explanation.rule}" overridden: ${explanation.overrideJustification}`
          : `Rule "${explanation.rule}" produced ${explanation.severity} signal`,
        {
          rule: explanation.rule,
          severity: explanation.severity,
          affectedComponent: explanation.affectedComponent,
        },
        explanation.overridden ? 'overridden' : 'active',
        { overrideJustification: explanation.overrideJustification },
      );
    },

    getRecords(filter) {
      if (!filter) return [...records];
      return records.filter((r) => matchesFilter(r, filter));
    },

    getByComponent(component) {
      return records.filter((r) => r.component === component);
    },

    getByType(type) {
      return records.filter((r) => r.type === type);
    },
  };
}
