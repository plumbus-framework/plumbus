import { describe, expect, it } from "vitest";
import type { GovernanceResult } from "../../governance/rule-engine.js";
import {
    ruleCapabilityMissingAccessPolicy as govRuleCapabilityMissingAccessPolicy,
    securityRules,
} from "../../governance/rules/index.js";
import {
    assertGovernanceSignals,
    assertMaxSeverity,
    assertNoGovernanceSignal,
    assertOverridesApplied,
    assertPolicyCompliance,
    assertPolicyNonCompliance,
    emptyInventory,
    evaluateGovernance,
} from "../governance.js";

// ── Helpers ──

function makeResult(signals: Array<{ rule: string; severity: string; description: string }>, overrideApplied: string[] = []): GovernanceResult {
  const mappedSignals = signals.map((s) => ({
    rule: s.rule,
    severity: s.severity as any,
    description: s.description,
    affectedComponent: "test",
  }));
  const mappedOverrides = overrideApplied.map((rule) => ({
    rule,
    justification: "test override",
    author: "admin",
    timestamp: new Date(),
  }));
  const effective = mappedSignals.filter(
    (s) => !overrideApplied.includes(s.rule),
  );
  return {
    signals: mappedSignals,
    effective,
    overrideApplied: mappedOverrides,
    summary: {
      total: mappedSignals.length,
      high: mappedSignals.filter((s) => s.severity === "high").length,
      warning: mappedSignals.filter((s) => s.severity === "warning").length,
      info: mappedSignals.filter((s) => s.severity === "info").length,
      overridden: mappedOverrides.length,
    },
  };
}

// ── assertGovernanceSignals ──

describe("assertGovernanceSignals", () => {
  it("passes when all expected rules fired", () => {
    const result = makeResult([
      { rule: "rule-1", severity: "warning", description: "test" },
      { rule: "rule-2", severity: "info", description: "test" },
    ]);
    expect(() => assertGovernanceSignals(result, ["rule-1", "rule-2"])).not.toThrow();
  });

  it("passes when checking a subset of fired rules", () => {
    const result = makeResult([
      { rule: "rule-1", severity: "warning", description: "test" },
      { rule: "rule-2", severity: "info", description: "test" },
    ]);
    expect(() => assertGovernanceSignals(result, ["rule-1"])).not.toThrow();
  });

  it("throws when expected rule did not fire", () => {
    const result = makeResult([
      { rule: "rule-1", severity: "warning", description: "test" },
    ]);
    expect(() => assertGovernanceSignals(result, ["rule-99"])).toThrow("rule-99");
  });
});

// ── assertNoGovernanceSignal ──

describe("assertNoGovernanceSignal", () => {
  it("passes when unexpected rules did not fire", () => {
    const result = makeResult([
      { rule: "rule-1", severity: "warning", description: "test" },
    ]);
    expect(() => assertNoGovernanceSignal(result, ["rule-2", "rule-3"])).not.toThrow();
  });

  it("throws when an unexpected rule fired", () => {
    const result = makeResult([
      { rule: "rule-1", severity: "warning", description: "test" },
    ]);
    expect(() => assertNoGovernanceSignal(result, ["rule-1"])).toThrow("rule-1");
  });
});

// ── assertMaxSeverity ──

describe("assertMaxSeverity", () => {
  it("passes when all signals are at or below max severity", () => {
    const result = makeResult([
      { rule: "r1", severity: "info", description: "ok" },
      { rule: "r2", severity: "warning", description: "ok" },
    ]);
    expect(() => assertMaxSeverity(result, "warning")).not.toThrow();
  });

  it("throws when a signal exceeds max severity", () => {
    const result = makeResult([
      { rule: "r1", severity: "info", description: "ok" },
      { rule: "r2", severity: "high", description: "bad" },
    ]);
    expect(() => assertMaxSeverity(result, "warning")).toThrow("high");
  });

  it("passes for info max when only info signals exist", () => {
    const result = makeResult([
      { rule: "r1", severity: "info", description: "ok" },
    ]);
    expect(() => assertMaxSeverity(result, "info")).not.toThrow();
  });
});

// ── assertOverridesApplied ──

describe("assertOverridesApplied", () => {
  it("passes when expected override is applied", () => {
    const result = makeResult([], ["rule-1"]);
    expect(() => assertOverridesApplied(result, ["rule-1"])).not.toThrow();
  });

  it("throws when expected override is not applied", () => {
    const result = makeResult([], []);
    expect(() => assertOverridesApplied(result, ["rule-1"])).toThrow("rule-1");
  });
});

// ── evaluateGovernance ──

describe("evaluateGovernance", () => {
  it("evaluates rules against an inventory", () => {
    const inventory = emptyInventory({
      capabilities: [
        {
          name: "no-access-policy",
          kind: "action",
          domain: "test",
          input: {} as any,
          output: {} as any,
          effects: { data: [], events: [], external: [], ai: false },
          handler: async () => ({}),
          // No access policy → should trigger security rule
        },
      ] as any,
    });
    const result = evaluateGovernance(securityRules, inventory);
    expect(result.signals.length).toBeGreaterThan(0);
  });

  it("returns no signals for compliant inventory", () => {
    const inventory = emptyInventory({
      capabilities: [
        {
          name: "compliant-cap",
          kind: "action",
          domain: "test",
          input: {} as any,
          output: {} as any,
          effects: { data: [], events: [], external: [], ai: false },
          access: { roles: ["admin"] },
          audit: { enabled: true, event: "test" },
          handler: async () => ({}),
        },
      ] as any,
      entities: [],
    });
    const result = evaluateGovernance([govRuleCapabilityMissingAccessPolicy], inventory);
    expect(result.signals).toHaveLength(0);
  });

  it("applies overrides", () => {
    const inventory = emptyInventory({
      capabilities: [
        {
          name: "no-policy",
          kind: "action",
          domain: "test",
          effects: { data: [], events: [], external: [], ai: false },
          handler: async () => ({}),
        },
      ] as any,
    });
    const result = evaluateGovernance(
      [govRuleCapabilityMissingAccessPolicy],
      inventory,
      [{
        rule: "security.capability-access-policy",
        justification: "test exception",
        author: "admin",
        timestamp: new Date(),
      }],
    );
    // Override should suppress the signal
    expect(result.effective).toHaveLength(0);
  });
});

// ── emptyInventory ──

describe("emptyInventory", () => {
  it("creates inventory with all empty arrays", () => {
    const inv = emptyInventory();
    expect(inv.capabilities).toEqual([]);
    expect(inv.entities).toEqual([]);
    expect(inv.flows).toEqual([]);
    expect(inv.events).toEqual([]);
    expect(inv.prompts).toEqual([]);
  });

  it("allows overriding specific collections", () => {
    const inv = emptyInventory({
      capabilities: [{ name: "test" }] as any,
    });
    expect(inv.capabilities).toHaveLength(1);
    expect(inv.entities).toEqual([]);
  });
});

// ── assertPolicyCompliance ──

describe("assertPolicyCompliance", () => {
  it("passes for fully compliant empty inventory", () => {
    const inventory = emptyInventory();
    // Empty inventories often score 100% as no rules fail
    expect(() => assertPolicyCompliance(inventory, "internal_security_baseline")).not.toThrow();
  });

  it("throws for non-compliant inventory", () => {
    const inventory = emptyInventory({
      capabilities: [
        {
          name: "no-access-policy",
          kind: "action",
          domain: "test",
          effects: { data: [], events: [], external: [], ai: false },
          handler: async () => ({}),
          // Missing access policy
        },
      ] as any,
    });
    expect(() => assertPolicyCompliance(inventory, "internal_security_baseline")).toThrow("compliance");
  });
});

// ── assertPolicyNonCompliance ──

describe("assertPolicyNonCompliance", () => {
  it("passes when inventory fails policy", () => {
    const inventory = emptyInventory({
      capabilities: [
        {
          name: "no-policy",
          kind: "action",
          domain: "test",
          effects: { data: [], events: [], external: [], ai: false },
          handler: async () => ({}),
        },
      ] as any,
    });
    expect(() => assertPolicyNonCompliance(inventory, "internal_security_baseline")).not.toThrow();
  });

  it("throws when inventory passes policy", () => {
    const inventory = emptyInventory();
    expect(() => assertPolicyNonCompliance(inventory, "internal_security_baseline")).toThrow("FAIL");
  });
});
