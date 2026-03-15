# @plumbus/ui — UI Code Generation Framework

`@plumbus/ui` is the frontend code generation layer for the Plumbus framework. It reads capability contracts, flow definitions, and auth configuration from `plumbus-core` and produces ready-to-use TypeScript/React source files — typed API clients, React hooks, auth modules, form metadata, and full Next.js project scaffolds.

## Purpose

All generated output is **source code as strings** — the package does not ship React components or a runtime. Instead, AI agents and CLI tooling call generator functions to produce `.ts`/`.tsx` files that applications import directly.

## Package Layout

```
packages/ui/
  src/
    index.ts                          # Barrel re-exports
    generators/
      index.ts                        # Generator barrel
      client-generator.ts             # Typed fetch clients + React hooks
      auth-generator.ts               # Auth types, token utils, hooks, route guard
      form-generator.ts               # Zod schema → form field metadata
      nextjs-template.ts              # Full Next.js project scaffold
      __tests__/
        client-generator.test.ts
        auth-generator.test.ts
        form-generator.test.ts
        nextjs-template.test.ts
  instructions/                       # AI agent instructions (this directory)
  package.json
  tsconfig.json
  vitest.config.browser.ts
```

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Generator** | A function that takes a contract/config and returns a string of TypeScript/TSX source code |
| **CapabilityContract** | Imported from `plumbus-core` — defines name, domain, kind, input/output schemas, access |
| **Module generator** | Combines multiple generators into a single file with proper imports |
| **GeneratedFile** | `{ path: string; content: string }` — represents a file to write to disk |

## Generator Categories

| Generator | Input | Output |
|-----------|-------|--------|
| **Client** | `CapabilityContract[]`, `FlowTriggerInput[]` | Typed fetch functions, React query/mutation hooks |
| **Auth** | `AuthHelperConfig` | Login/logout, token utils, useAuth hook, RouteGuard, tenant context |
| **Form** | `CapabilityContract` (with Zod input schema) | Field metadata (type, label, validation, options) |
| **Next.js** | `NextjsTemplateConfig`, capabilities | Full project: package.json, layout, pages, middleware, API routes |

## Relationship to plumbus-core

`@plumbus/ui` depends on `plumbus-core` for:
- `CapabilityContract` type — the shape of capability definitions
- Zod schemas — introspected at runtime for form hint extraction
- No runtime coupling — generators produce standalone code

## Key Imports

```ts
import {
  // Client generators
  generateClientModule,
  generateHooksModule,
  generateTypedClient,
  generateReactHook,
  generateCapabilityTypes,
  generateFlowTrigger,
  generateErrorTypes,

  // Auth generators
  generateAuthModule,
  generateAuthTypes,
  generateTokenUtils,
  generateAuthFunctions,
  generateUseAuthHook,
  generateUseCurrentUserHook,
  generateRouteGuard,
  generateTenantContext,

  // Form generators
  extractFormHints,
  extractFieldHint,
  generateFormHintsCode,
  generateFormHintsModule,

  // Next.js generators
  generateNextjsTemplate,
  generateLayout,
  generateHomePage,
  generateCapabilityPage,
  generateMiddleware,
  generateApiRouteHelper,
  generateAuthProvider,
  generateErrorBoundary,
  generateLoadingComponent,
  generatePackageJson,
  generateTsConfig,
  generateEnvLocal,
  generatePlaceholderFiles,
} from "@plumbus/ui";
```

## How Agents Should Use This Package

1. **Run `plumbus ui generate`** — auto-detects the frontend directory (e.g., `frontend/`) and writes typed client, hooks, auth, and form-hints modules to `{frontend}/generated/`. Also writes to `.plumbus/generated/ui/` as a contract artifact cache.
2. **Run `plumbus ui nextjs <dir>`** — scaffolds a Next.js project that includes the generated modules in `{dir}/generated/`. The frontend imports them via `@/generated/hooks`, `@/generated/client`, etc.
3. **Never copy generated files manually.** Re-running `plumbus ui generate` updates `{frontend}/generated/` in place. The CLI auto-detects the frontend by looking for `tsconfig.json` in `frontend/`, `web/`, `client/`, or `app/`.
4. To customize the output location: `plumbus ui generate --out-dir path/to/generated`.
