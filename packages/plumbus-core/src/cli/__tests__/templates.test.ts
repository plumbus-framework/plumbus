import { describe, expect, it } from "vitest";
import {
    capabilityTemplate,
    capabilityTestTemplate,
    entityTemplate,
    eventTemplate,
    flowTemplate,
    promptTemplate,
} from "../templates/resources.js";

describe("Resource templates", () => {
  it("generates capability template with correct kind and domain", () => {
    const result = capabilityTemplate("approveRefund", "action", "billing");
    expect(result).toContain('name: "approveRefund"');
    expect(result).toContain('kind: "action"');
    expect(result).toContain('domain: "billing"');
    expect(result).toContain("defineCapability");
    expect(result).toContain("handler: async (ctx, input)");
  });

  it("generates capability test template", () => {
    const result = capabilityTestTemplate("approveRefund", "billing");
    expect(result).toContain("ApproveRefund");
    expect(result).toContain("describe");
  });

  it("generates entity template with fields", () => {
    const result = entityTemplate("customer");
    expect(result).toContain("defineEntity");
    expect(result).toContain('name: "Customer"');
    expect(result).toContain("field.id()");
    expect(result).toContain("tenantScoped: true");
  });

  it("generates flow template with correct structure", () => {
    const result = flowTemplate("refund-approval", "billing");
    expect(result).toContain("defineFlow");
    expect(result).toContain('name: "refund-approval"');
    expect(result).toContain('domain: "billing"');
    expect(result).toContain("steps:");
  });

  it("generates event template", () => {
    const result = eventTemplate("orderPlaced");
    expect(result).toContain("defineEvent");
    expect(result).toContain('name: "orderPlaced"');
  });

  it("generates prompt template", () => {
    const result = promptTemplate("summarizeTicket");
    expect(result).toContain("definePrompt");
    expect(result).toContain('name: "summarizeTicket"');
    expect(result).toContain("model:");
  });
});
