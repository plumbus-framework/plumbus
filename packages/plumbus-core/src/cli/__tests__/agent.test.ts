import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityContract } from "../../types/capability.js";
import type { EntityDefinition } from "../../types/entity.js";
import { FieldClassification } from "../../types/enums.js";
import {
    generateCapabilityBrief,
    generateEntityBrief,
    generateProjectBriefFromResources,
} from "../commands/agent.js";

describe("plumbus agent", () => {
  describe("generateCapabilityBrief", () => {
    it("includes capability metadata", () => {
      const cap: CapabilityContract = {
        name: "approveRefund",
        kind: "action",
        domain: "billing",
        description: "Approve a refund request",
        input: z.object({}),
        output: z.object({}),
        access: { roles: ["admin", "manager"], tenantScoped: true },
        effects: { data: ["refunds"], events: ["refund.approved"], external: [], ai: false },
        handler: async () => ({}),
      };
      const brief = generateCapabilityBrief(cap);
      expect(brief).toContain("approveRefund");
      expect(brief).toContain("billing");
      expect(brief).toContain("action");
      expect(brief).toContain("admin, manager");
      expect(brief).toContain("refund.approved");
    });
  });

  describe("generateEntityBrief", () => {
    it("includes field classifications", () => {
      const entity: EntityDefinition = {
        name: "Customer",
        tenantScoped: true,
        fields: {
          id: { type: "id", options: {} },
          email: { type: "string", options: { classification: FieldClassification.Personal } },
        },
      };
      const brief = generateEntityBrief(entity);
      expect(brief).toContain("Customer");
      expect(brief).toContain("email");
      expect(brief).toContain("personal");
      expect(brief).toContain("Tenant-scoped");
    });
  });

  describe("generateProjectBriefFromResources", () => {
    it("lists all resource counts", () => {
      const brief = generateProjectBriefFromResources([], [], [], [], []);
      expect(brief).toContain("Entities (0)");
      expect(brief).toContain("Capabilities (0)");
      expect(brief).toContain("Flows (0)");
      expect(brief).toContain("Events (0)");
      expect(brief).toContain("Prompts (0)");
    });

    it("includes entity details when provided", () => {
      const entities: EntityDefinition[] = [
        { name: "Customer", tenantScoped: true, fields: { id: { type: "id", options: {} } } },
      ];
      const brief = generateProjectBriefFromResources([], entities, [], [], []);
      expect(brief).toContain("Customer");
      expect(brief).toContain("tenant-scoped");
    });
  });
});
