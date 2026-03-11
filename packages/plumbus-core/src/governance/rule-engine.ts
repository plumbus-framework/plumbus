// ── Governance Rule Engine ──
// Evaluates rules against system metadata (entities, capabilities, flows, events, prompts, AI config)
// Each rule produces GovernanceSignals

import type { CapabilityContract } from "../types/capability.js";
import type { EntityDefinition } from "../types/entity.js";
import type { GovernanceSeverity } from "../types/enums.js";
import type { EventDefinition } from "../types/event.js";
import type { FlowDefinition } from "../types/flow.js";
import type { GovernanceOverride, GovernanceSignal } from "../types/governance.js";
import type { PromptDefinition } from "../types/prompt.js";

// ── Rule Category ──
export type RuleCategory = "security" | "privacy" | "architecture" | "ai";

// ── System Inventory — everything the engine evaluates ──
export interface SystemInventory {
  capabilities: CapabilityContract[];
  entities: EntityDefinition[];
  flows: FlowDefinition[];
  events: EventDefinition[];
  prompts: PromptDefinition[];
}

// ── Governance Rule ──
export interface GovernanceRule {
  id: string;
  category: RuleCategory;
  severity: GovernanceSeverity;
  description: string;
  evaluate: (inventory: SystemInventory) => GovernanceSignal[];
}

// ── Engine Result ──
export interface GovernanceResult {
  signals: GovernanceSignal[];
  overrideApplied: GovernanceOverride[];
  /** Signals that remain after overrides */
  effective: GovernanceSignal[];
  summary: {
    total: number;
    high: number;
    warning: number;
    info: number;
    overridden: number;
  };
}

// ── Rule Engine ──
export interface GovernanceRuleEngine {
  register(rule: GovernanceRule): void;
  registerMany(rules: GovernanceRule[]): void;
  unregister(ruleId: string): void;
  getRules(): GovernanceRule[];
  getRulesByCategory(category: RuleCategory): GovernanceRule[];
  evaluate(inventory: SystemInventory, overrides?: GovernanceOverride[]): GovernanceResult;
}

export function createGovernanceRuleEngine(): GovernanceRuleEngine {
  const rules = new Map<string, GovernanceRule>();

  return {
    register(rule) {
      rules.set(rule.id, rule);
    },

    registerMany(newRules) {
      for (const rule of newRules) {
        rules.set(rule.id, rule);
      }
    },

    unregister(ruleId) {
      rules.delete(ruleId);
    },

    getRules() {
      return [...rules.values()];
    },

    getRulesByCategory(category) {
      return [...rules.values()].filter((r) => r.category === category);
    },

    evaluate(inventory, overrides = []) {
      const allSignals: GovernanceSignal[] = [];
      for (const rule of rules.values()) {
        const signals = rule.evaluate(inventory);
        allSignals.push(...signals);
      }

      // Determine which signals are overridden
      const overrideRules = new Set(overrides.map((o) => o.rule));
      const overrideApplied: GovernanceOverride[] = [];
      const effective: GovernanceSignal[] = [];

      for (const signal of allSignals) {
        if (overrideRules.has(signal.rule)) {
          const override = overrides.find((o) => o.rule === signal.rule);
          if (override && !overrideApplied.includes(override)) {
            overrideApplied.push(override);
          }
        } else {
          effective.push(signal);
        }
      }

      return {
        signals: allSignals,
        overrideApplied,
        effective,
        summary: {
          total: allSignals.length,
          high: effective.filter((s) => s.severity === "high").length,
          warning: effective.filter((s) => s.severity === "warning").length,
          info: effective.filter((s) => s.severity === "info").length,
          overridden: allSignals.length - effective.length,
        },
      };
    },
  };
}
