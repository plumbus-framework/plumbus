import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { CapabilityContract, CapabilityEffects } from "../../types/capability.js";
import {
    generateAll,
    generateClientFunction,
    generateManifestEntry,
    generateOpenApiPath,
    generateReactHook,
} from "../commands/generate.js";

function mockCapability(overrides?: Partial<CapabilityContract>): CapabilityContract {
  return {
    name: "getInvoice",
    kind: "query",
    domain: "billing",
    input: z.object({ id: z.string() }),
    output: z.object({ total: z.number() }),
    effects: { data: [], events: [], external: [], ai: false } satisfies CapabilityEffects,
    handler: async () => ({ total: 100 }),
    ...overrides,
  };
}

describe("plumbus generate", () => {
  describe("generateClientFunction", () => {
    it("generates GET for query capabilities", () => {
      const fn = generateClientFunction(mockCapability());
      expect(fn).toContain("GET");
      expect(fn).toContain("/api/billing/get-invoice");
      expect(fn).toContain("getInvoice");
    });

    it("generates POST for action capabilities", () => {
      const fn = generateClientFunction(mockCapability({ kind: "action", name: "createInvoice" }));
      expect(fn).toContain("POST");
      expect(fn).toContain("JSON.stringify(input)");
    });
  });

  describe("generateReactHook", () => {
    it("generates query hook with useEffect pattern", () => {
      const hook = generateReactHook(mockCapability());
      expect(hook).toContain("useGetInvoice");
      expect(hook).toContain("useEffect");
      expect(hook).toContain("loading");
    });

    it("generates mutation hook for actions", () => {
      const hook = generateReactHook(mockCapability({ kind: "action", name: "createOrder" }));
      expect(hook).toContain("useCreateOrder");
      expect(hook).toContain("mutate");
    });
  });

  describe("generateOpenApiPath", () => {
    it("generates correct OpenAPI path entry", () => {
      const path = generateOpenApiPath(mockCapability());
      expect(path).toHaveProperty("/api/billing/get-invoice");
    });
  });

  describe("generateManifestEntry", () => {
    it("includes all contract metadata", () => {
      const entry = generateManifestEntry(mockCapability());
      expect(entry.name).toBe("getInvoice");
      expect(entry.kind).toBe("query");
      expect(entry.domain).toBe("billing");
    });
  });

  describe("generateAll", () => {
    it("generates all artifacts for empty capability list", () => {
      const tmpDir = "/tmp/plumbus-test-gen-" + Date.now();
      const generated = generateAll([], tmpDir);
      expect(generated).toContain("clients/api.ts");
      expect(generated).toContain("clients/hooks.ts");
      expect(generated).toContain("openapi.json");
      expect(generated).toContain("manifest.json");
    });
  });
});
