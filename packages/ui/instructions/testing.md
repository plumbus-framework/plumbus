# Testing

The UI package uses Vitest for unit tests and optionally Playwright via `@vitest/browser` for browser-based tests.

## Test Setup

```bash
# Unit tests (Node)
pnpm --filter @plumbus/ui test

# Browser tests (Playwright + Chromium)
pnpm --filter @plumbus/ui test:browser
```

Config files:
- Unit tests: uses default Vitest config from workspace root
- Browser tests: `vitest.config.browser.ts` — runs in Chromium via `@vitest/browser`

## Test Files

```
src/generators/__tests__/
  client-generator.test.ts     # 200+ lines — client/hook/flow generation
  auth-generator.test.ts       # 160+ lines — auth types/functions/hooks
  form-generator.test.ts       # 220+ lines — Zod schema introspection
  nextjs-template.test.ts      # 180+ lines — project scaffold
```

## Testing Strategy

All generators produce **strings of source code**. Tests verify the generated code by:
1. Checking string contents with `toContain()` for expected patterns.
2. Validating JSON outputs with `JSON.parse()` (e.g. package.json).
3. Verifying structural properties (function names, type names, imports).

## Writing Tests for Generators

### Test a Capability-Based Generator

Create a mock `CapabilityContract` and pass it to the generator:

```ts
import { describe, it, expect } from "vitest";
import { generateTypedClient } from "../client-generator.js";
import type { CapabilityContract } from "plumbus-core";

const mockCap: CapabilityContract = {
  name: "getUser",
  kind: "query",
  domain: "users",
  description: "Get a user by ID",
  input: {} as any,
  output: {} as any,
  access: { roles: ["admin"] },
  effects: [],
};

describe("generateTypedClient", () => {
  it("generates a GET client for query capabilities", () => {
    const code = generateTypedClient(mockCap);
    expect(code).toContain("export async function getUser");
    expect(code).toContain('method: "GET"');
    expect(code).toContain("/api/users/get-user");
  });

  it("includes JSDoc when configured", () => {
    const code = generateTypedClient(mockCap, { includeJsDoc: true });
    expect(code).toContain("/** Get a user by ID */");
  });

  it("uses custom base URL", () => {
    const code = generateTypedClient(mockCap, { baseUrl: "https://api.example.com" });
    expect(code).toContain("https://api.example.com/api/users/get-user");
  });
});
```

### Test a Config-Based Generator

```ts
import { generateAuthModule } from "../auth-generator.js";

describe("generateAuthModule", () => {
  it("includes all auth sections", () => {
    const code = generateAuthModule({ provider: "jwt" });
    expect(code).toContain("interface AuthUser");
    expect(code).toContain("function login");
    expect(code).toContain("function useAuth");
    expect(code).toContain("function RouteGuard");
  });

  it("includes tenant context when multiTenant enabled", () => {
    const code = generateAuthModule({ provider: "jwt", multiTenant: true });
    expect(code).toContain("function useTenant");
  });

  it("excludes tenant context by default", () => {
    const code = generateAuthModule({ provider: "jwt" });
    expect(code).not.toContain("useTenant");
  });
});
```

### Test Form Hint Extraction with Zod

```ts
import { z } from "zod";
import { extractFieldHint, extractFormHints } from "../form-generator.js";
import type { CapabilityContract } from "plumbus-core";

describe("extractFieldHint", () => {
  it("extracts string field", () => {
    const hint = extractFieldHint("name", z.string().min(1).max(100));
    expect(hint.fieldType).toBe("text");
    expect(hint.required).toBe(true);
    expect(hint.validation.minLength).toBe(1);
    expect(hint.validation.maxLength).toBe(100);
  });

  it("extracts enum field with options", () => {
    const hint = extractFieldHint("role", z.enum(["admin", "user", "guest"]));
    expect(hint.fieldType).toBe("select");
    expect(hint.options).toEqual(["admin", "user", "guest"]);
  });

  it("handles optional fields", () => {
    const hint = extractFieldHint("nickname", z.string().optional());
    expect(hint.required).toBe(false);
  });

  it("extracts default values", () => {
    const hint = extractFieldHint("active", z.boolean().default(true));
    expect(hint.required).toBe(false);
    expect(hint.defaultValue).toBe(true);
  });
});

describe("extractFormHints", () => {
  it("extracts all fields from a capability", () => {
    const cap = {
      name: "createUser",
      kind: "action",
      domain: "users",
      input: z.object({
        name: z.string(),
        email: z.string().email(),
        role: z.enum(["admin", "user"]),
      }),
    } as unknown as CapabilityContract;

    const hints = extractFormHints(cap);
    expect(hints.fields).toHaveLength(3);
    expect(hints.fields[0]!.name).toBe("name");
    expect(hints.fields[1]!.validation.pattern).toBe("email");
    expect(hints.fields[2]!.fieldType).toBe("select");
  });
});
```

### Test Next.js Template Generation

```ts
import { generateNextjsTemplate, generatePackageJson } from "../nextjs-template.js";

describe("generateNextjsTemplate", () => {
  it("generates valid package.json", () => {
    const file = generatePackageJson({ appName: "My App" });
    const parsed = JSON.parse(file.content);
    expect(parsed.name).toBe("my-app");
    expect(parsed.dependencies.next).toBeDefined();
  });

  it("includes auth files when auth enabled", () => {
    const files = generateNextjsTemplate({ appName: "Test", auth: true });
    const paths = files.map((f) => f.path);
    expect(paths).toContain("components/AuthProvider.tsx");
  });

  it("generates capability pages", () => {
    const cap = { name: "getUser", kind: "query", domain: "users" } as any;
    const files = generateNextjsTemplate({ appName: "Test" }, [cap]);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("app/get-user/page.tsx");
  });
});
```

## Test Patterns Summary

| Pattern | When to Use |
|---------|-------------|
| `toContain(string)` | Verify specific code appears in output |
| `not.toContain(string)` | Verify code is excluded (e.g. optional features) |
| `JSON.parse(output)` | Validate JSON file content (package.json, tsconfig) |
| `files.map(f => f.path)` | Check generated file paths in multi-file output |
| Mock `CapabilityContract` | Any generator that takes a capability |
| Mock Zod schemas | Form hint extraction tests |
| Config variations | Test generator options (auth, baseUrl, multiTenant) |

## Running Specific Tests

```bash
# Run all UI tests
pnpm --filter @plumbus/ui test

# Run a specific test file
pnpm --filter @plumbus/ui test -- client-generator

# Run with watch mode
pnpm --filter @plumbus/ui test -- --watch
```
