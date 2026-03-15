// ── Resource Templates ──
// Code templates for scaffolding new resources

import { toCamelCase, toPascalCase } from '../utils.js';

export function capabilityTemplate(name: string, kind: string, domain: string): string {
  const pascal = toPascalCase(name);
  return `import { defineCapability } from "plumbus-core";
import { z } from "zod";

export const ${toCamelCase(name)} = defineCapability({
  name: "${name}",
  kind: "${kind}",
  domain: "${domain}",

  input: z.object({
    // TODO: define input schema
  }),

  output: z.object({
    // TODO: define output schema
  }),

  access: {
    roles: [],
    scopes: [],
  },

  effects: {
    data: [],
    events: [],
    external: [],
    ai: false,
  },

  handler: async (ctx, input) => {
    // TODO: implement ${pascal}
    return {};
  },
});
`;
}

export function capabilityTestTemplate(name: string, _domain: string): string {
  return `import { describe, it, expect } from "vitest";
// import { ${toCamelCase(name)} } from "../capability.js";

describe("${toPascalCase(name)}", () => {
  it("should execute successfully", async () => {
    // TODO: implement test using runCapability() or createTestContext()
    expect(true).toBe(true);
  });
});
`;
}

export function entityTemplate(name: string): string {
  const pascal = toPascalCase(name);
  return `import { defineEntity, field } from "plumbus-core";

export const ${toCamelCase(name)}Entity = defineEntity({
  name: "${pascal}",
  tenantScoped: true,

  fields: {
    id: field.id(),
    // TODO: add fields
    createdAt: field.timestamp({ required: true }),
    updatedAt: field.timestamp({ required: true }),
  },

  indexes: [],
});
`;
}

export function flowTemplate(name: string, domain: string): string {
  return `import { defineFlow } from "plumbus-core";
import { z } from "zod";

export const ${toCamelCase(name)}Flow = defineFlow({
  name: "${name}",
  domain: "${domain}",

  input: z.object({
    // TODO: define flow input
  }),

  steps: [
    {
      name: "step1",
      type: "capability",
      capability: "TODO",
    },
  ],
});
`;
}

export function flowTestTemplate(name: string, _domain: string): string {
  return `import { describe, it, expect } from "vitest";
import { simulateFlow } from "plumbus-core/testing";
import { ${toCamelCase(name)}Flow } from "../flow.js";

describe("${toPascalCase(name)} Flow", () => {
  it("completes all steps successfully", async () => {
    const result = await simulateFlow(${toCamelCase(name)}Flow, {
      // TODO: provide valid flow input
    });
    expect(result.status).toBe("completed");
    expect(result.history.length).toBeGreaterThan(0);
  });

  it("handles step failure", async () => {
    const result = await simulateFlow(${toCamelCase(name)}Flow, {
      // TODO: provide valid flow input
    }, {
      capabilityResults: {
        // TODO: map step name → failure
      },
    });
    expect(result.status).toBe("failed");
  });
});
`;
}

export function eventTemplate(name: string): string {
  return `import { defineEvent } from "plumbus-core";
import { z } from "zod";

export const ${toCamelCase(name)}Event = defineEvent({
  name: "${name}",

  payload: z.object({
    // TODO: define event payload
  }),
});
`;
}

export function promptTemplate(name: string): string {
  return `import { definePrompt } from "plumbus-core";
import { z } from "zod";

export const ${toCamelCase(name)}Prompt = definePrompt({
  name: "${name}",

  input: z.object({
    // TODO: define prompt input variables
  }),

  output: z.object({
    // TODO: define expected output schema
  }),

  model: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.7,
  },
});
`;
}
