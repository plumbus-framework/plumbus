import { describe, expect, it } from "vitest";
import { createCostTracker, estimateCost, type BudgetConfig } from "../cost-tracker.js";

describe("Cost Tracker", () => {
  describe("estimateCost", () => {
    it("estimates cost for known model", () => {
      const cost = estimateCost("gpt-4o", {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      });
      // gpt-4o: $2.5/1M input, $10/1M output
      // 1000 * 2.5 / 1M + 500 * 10 / 1M = 0.0025 + 0.005 = 0.0075
      expect(cost).toBeCloseTo(0.0075, 4);
    });

    it("uses fallback rate for unknown model", () => {
      const cost = estimateCost("unknown-model", {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      });
      // fallback: $5/1M input, $15/1M output
      expect(cost).toBeCloseTo(0.0125, 4);
    });
  });

  describe("createCostTracker", () => {
    it("records and retrieves cost entries", () => {
      const tracker = createCostTracker();
      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.001,
        latencyMs: 500,
      });

      const records = tracker.getRecords();
      expect(records).toHaveLength(1);
      expect(records[0]!.model).toBe("gpt-4o");
      expect(records[0]!.id).toBeDefined();
      expect(records[0]!.timestamp).toBeInstanceOf(Date);
    });

    it("tracks daily usage", () => {
      const tracker = createCostTracker();
      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.001,
        latencyMs: 500,
      });
      tracker.record({
        model: "gpt-4o",
        operation: "extract",
        usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        estimatedCost: 0.002,
        latencyMs: 300,
      });

      const daily = tracker.getDailyUsage();
      expect(daily.requestCount).toBe(2);
      expect(daily.totalTokens).toBe(450);
      expect(daily.totalCost).toBeCloseTo(0.003, 4);
    });

    it("filters daily usage by tenant", () => {
      const tracker = createCostTracker();
      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.001,
        latencyMs: 500,
        tenantId: "t1",
      });
      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.001,
        latencyMs: 500,
        tenantId: "t2",
      });

      expect(tracker.getDailyUsage("t1").requestCount).toBe(1);
      expect(tracker.getDailyUsage("t2").requestCount).toBe(1);
    });

    it("enforces max tokens per request", () => {
      const budget: BudgetConfig = { maxTokensPerRequest: 1000 };
      const tracker = createCostTracker(budget);

      expect(tracker.checkBudget({ estimatedTokens: 500 }).allowed).toBe(true);
      expect(tracker.checkBudget({ estimatedTokens: 1500 }).allowed).toBe(false);
      expect(tracker.checkBudget({ estimatedTokens: 1500 }).reason).toContain(
        "per-request limit",
      );
    });

    it("enforces daily cost limit", () => {
      const budget: BudgetConfig = { dailyCostLimit: 0.01 };
      const tracker = createCostTracker(budget);

      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.01,
        latencyMs: 200,
      });

      const result = tracker.checkBudget({});
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("Daily cost limit");
    });

    it("enforces per-tenant daily limit", () => {
      const budget: BudgetConfig = { perTenantDailyLimit: 0.005 };
      const tracker = createCostTracker(budget);

      tracker.record({
        model: "gpt-4o",
        operation: "generate",
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        estimatedCost: 0.005,
        latencyMs: 200,
        tenantId: "t1",
      });

      expect(tracker.checkBudget({ tenantId: "t1" }).allowed).toBe(false);
      expect(tracker.checkBudget({ tenantId: "t2" }).allowed).toBe(true);
    });

    it("allows when under budget", () => {
      const budget: BudgetConfig = {
        maxTokensPerRequest: 5000,
        dailyCostLimit: 100,
        perTenantDailyLimit: 50,
      };
      const tracker = createCostTracker(budget);

      const result = tracker.checkBudget({
        tenantId: "t1",
        estimatedTokens: 1000,
      });
      expect(result.allowed).toBe(true);
    });
  });
});
