// ── Built-in Architecture Governance Rules ──

import { GovernanceSeverity } from "../../types/enums.js";
import type { GovernanceRule } from "../rule-engine.js";

/** Capabilities with too many side effects */
export const ruleExcessiveEffects: GovernanceRule = {
  id: "architecture.excessive-effects",
  category: "architecture",
  severity: GovernanceSeverity.Warning,
  description: "Capabilities should not have excessive side effects",
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => {
        const e = cap.effects;
        const total = (e.data?.length ?? 0) + (e.events?.length ?? 0) + (e.external?.length ?? 0);
        return total > 10;
      })
      .map((cap) => {
        const e = cap.effects;
        const total = (e.data?.length ?? 0) + (e.events?.length ?? 0) + (e.external?.length ?? 0);
        return {
          severity: GovernanceSeverity.Warning,
          rule: "architecture.excessive-effects",
          description: `Capability "${cap.name}" declares ${total} effects — consider splitting`,
          affectedComponent: `capability:${cap.name}`,
          remediation: "Break the capability into smaller, focused capabilities",
        };
      });
  },
};

/** Flows with excessive branching */
export const ruleExcessiveFlowBranching: GovernanceRule = {
  id: "architecture.excessive-flow-branching",
  category: "architecture",
  severity: GovernanceSeverity.Warning,
  description: "Flows should not have excessive conditional branching",
  evaluate(inventory) {
    return inventory.flows
      .filter((flow) => {
        const conditionalCount = flow.steps.filter((s) => s.type === "conditional").length;
        return conditionalCount > 5;
      })
      .map((flow) => {
        const conditionalCount = flow.steps.filter((s) => s.type === "conditional").length;
        return {
          severity: GovernanceSeverity.Warning,
          rule: "architecture.excessive-flow-branching",
          description: `Flow "${flow.name}" has ${conditionalCount} conditional branches — consider simplifying`,
          affectedComponent: `flow:${flow.name}`,
          remediation: "Break the flow into smaller sub-flows or reduce conditional complexity",
        };
      });
  },
};

/** Missing audit on action/job capabilities */
export const ruleMissingAuditConfig: GovernanceRule = {
  id: "architecture.missing-audit",
  category: "architecture",
  severity: GovernanceSeverity.Warning,
  description: "Action and job capabilities should have audit logging enabled",
  evaluate(inventory) {
    return inventory.capabilities
      .filter((cap) => (cap.kind === "action" || cap.kind === "job") && cap.audit?.enabled === false)
      .map((cap) => ({
        severity: GovernanceSeverity.Warning,
        rule: "architecture.missing-audit",
        description: `Capability "${cap.name}" (${cap.kind}) has audit logging disabled`,
        affectedComponent: `capability:${cap.name}`,
        remediation: "Enable audit logging for action and job capabilities",
      }));
  },
};

/** Large number of flow steps */
export const ruleExcessiveFlowSteps: GovernanceRule = {
  id: "architecture.excessive-flow-steps",
  category: "architecture",
  severity: GovernanceSeverity.Info,
  description: "Flows with many steps may be difficult to maintain",
  evaluate(inventory) {
    return inventory.flows
      .filter((flow) => flow.steps.length > 20)
      .map((flow) => ({
        severity: GovernanceSeverity.Info,
        rule: "architecture.excessive-flow-steps",
        description: `Flow "${flow.name}" has ${flow.steps.length} steps — consider decomposing into sub-flows`,
        affectedComponent: `flow:${flow.name}`,
        remediation: "Break large flows into smaller, composable sub-flows",
      }));
  },
};

/** Entity without description */
export const ruleEntityMissingDescription: GovernanceRule = {
  id: "architecture.entity-missing-description",
  category: "architecture",
  severity: GovernanceSeverity.Info,
  description: "Entities should have descriptions for documentation and agent usage",
  evaluate(inventory) {
    return inventory.entities
      .filter((entity) => !entity.description)
      .map((entity) => ({
        severity: GovernanceSeverity.Info,
        rule: "architecture.entity-missing-description",
        description: `Entity "${entity.name}" is missing a description`,
        affectedComponent: `entity:${entity.name}`,
        remediation: "Add a description to the entity definition",
      }));
  },
};

export const architectureRules: GovernanceRule[] = [
  ruleExcessiveEffects,
  ruleExcessiveFlowBranching,
  ruleMissingAuditConfig,
  ruleExcessiveFlowSteps,
  ruleEntityMissingDescription,
];
