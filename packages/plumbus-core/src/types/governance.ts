import type { GovernanceSeverity, PolicyProfile, RuleStatus } from './enums.js';

// ── Governance Signal ──
export interface GovernanceSignal {
  severity: GovernanceSeverity;
  rule: string;
  description: string;
  affectedComponent: string;
  remediation?: string;
}

// ── Governance Override ──
export interface GovernanceOverride {
  rule: string;
  justification: string;
  author: string;
  timestamp: Date;
}

// ── Rule Evaluation Result ──
export interface RuleEvaluation {
  rule: string;
  status: RuleStatus;
  severity: GovernanceSeverity;
  description?: string;
  remediation?: string;
}

// ── Policy Compatibility Report ──
export interface PolicyReport {
  policy: PolicyProfile | string;
  timestamp: Date;
  compatibilityScore?: number;
  results: RuleEvaluation[];
  overrides?: GovernanceOverride[];
  recommendations?: string[];
}
