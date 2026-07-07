# @plumbus/ui — UI Code Generation Framework

`@plumbus/ui` is the frontend source-code generation layer for Plumbus. Its purpose is to project backend Plumbus contracts into frontend source files without turning Plumbus into a visual UI framework.

The package reads Plumbus-facing inputs such as capability contracts, flow trigger descriptors, auth configuration, capability input schemas, Next.js template configuration, and translation definitions. It produces TypeScript/TSX source strings or generated file descriptors that an application or CLI wrapper can write to disk.

The package does not include a visual component library. It does include thin `next-intl` re-export subpaths used by generated translation files: `@plumbus/ui/next-intl` and `@plumbus/ui/next-intl-server`.

## Purpose

Generated output is ordinary source code owned by the consuming application. The main value of the package is alignment: frontend code calls the same capability names, endpoint paths, input/output shapes, flow trigger names, auth helper shape, and form metadata that the backend contracts define.

This is especially important when automated coding tools are involved. The generated files give those tools concrete imports and conventions instead of leaving them to invent request shapes or endpoint paths.

## Package layout

```text
packages/ui/
  src/
    index.ts
    next-intl/
      index.ts
    next-intl-server/
      index.ts
    generators/
      client-generator.ts
      auth-generator.ts
      form-generator.ts
      nextjs-template.ts
      translation-generator.ts
      __tests__/
        client-generator.test.ts
        auth-generator.test.ts
        form-generator.test.ts
        nextjs-template.test.ts
        translation-generator.test.ts
  instructions/
    framework.md
    client-generator.md
    auth-generator.md
    form-generator.md
    nextjs-template.md
    translation-generator.md
    patterns.md
    testing.md
  package.json
  tsconfig.json
  vitest.config.browser.ts
```

## Core concepts

A generator is a pure function that returns source code as a string or returns generated files as `{ path, content }` objects. Module generators combine several snippets into one source file; template generators return several files.

`CapabilityContract` and `TranslationDefinition` come from `@plumbus/core`. They are the input types that keep frontend generation tied to backend definitions. Generated code is then written into the consuming application and imported like ordinary application code.

## Generator categories

| Generator | Input | Output |
|---|---|---|
| Client | `CapabilityContract[]`, `FlowTriggerInput[]`, optional `ClientGeneratorConfig` | Typed fetch client module and flow triggers. |
| Hooks | `CapabilityContract[]`, optional `ClientGeneratorConfig` | React `useState`/`useEffect` query hooks and mutation hooks. |
| Auth | Optional `AuthHelperConfig` | Auth types, token helpers, login/logout/session-refresh functions, hooks, route guard, and optional tenant helper. |
| Form | `CapabilityContract` or `CapabilityContract[]` | Form hints extracted from `capability.input` Zod object schemas. |
| Next.js | `NextjsTemplateConfig` | Starter Next.js App Router shell. |
| Translation | `TranslationDefinition[]`, optional `TranslationGeneratorOptions` | `next-intl`-oriented i18n source files. |

## Relationship to `@plumbus/core`

`@plumbus/ui` consumes core definitions and types, but it does not move business logic into the browser. Generated clients and hooks are convenience code for calling backend capabilities. Authorization, policy decisions, durable workflow behavior, and audit-sensitive behavior remain backend responsibilities.

Most generated modules do not import `@plumbus/ui` at runtime. The translation generator is the explicit exception: generated i18n files import the package's `next-intl` re-export subpaths.

## Key imports

```ts
import {
  // client + hooks
  capabilityClientFnName,
  flowTriggerFnName,
  generateCapabilityTypes,
  generateClientModule,
  generateErrorTypes,
  generateFlowTrigger,
  generateHooksModule,
  generateMutationHook,
  generateQueryHook,
  generateReactHook,
  generateTypedClient,

  // auth
  generateAuthFunctions,
  generateAuthModule,
  generateAuthTypes,
  generateRouteGuard,
  generateTenantContext,
  generateTokenUtils,
  generateUseAuthHook,
  generateUseCurrentUserHook,

  // form hints
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,

  // Next.js starter scaffold
  generateAuthProvider,
  generateCapabilityPage,
  generateEnvLocal,
  generateErrorBoundary,
  generateGlobalsCss,
  generateHomePage,
  generateLayout,
  generateLoadingComponent,
  generateLoginPage,
  generateNextjsTemplate,
  generatePackageJson,
  generatePlaceholderFiles,
  generatePostcssConfig,
  generateProxy,
  generateSignupPage,
  generateTsConfig,

  // translations
  generateTranslationModule,
} from "@plumbus/ui";
```

```ts
import type {
  AuthHelperConfig,
  ClientGeneratorConfig,
  FlowTriggerInput,
  GeneratedFile,
  GeneratedTranslationFile,
  NextjsTemplateConfig,
  TranslationGeneratorOptions,
} from "@plumbus/ui";
```

## Recommended generation workflow

A typical web frontend first receives a starter shell from `generateNextjsTemplate(config)`. Contract-derived modules are then generated separately: `generateClientModule(capabilities, flows, config?)` for `lib/client.ts`, `generateHooksModule(capabilities, config?)` for `hooks/hooks.ts`, `generateAuthModule(config?)` for `lib/auth.ts`, `generateFormHintsModule(capabilities)` for `lib/form-hints.ts`, and `generateTranslationModule(definitions, options?)` for `i18n/*`.

Use `generateCapabilityPage(capability)` only when a minimal example page is useful. It is intentionally separate from the Next.js template and should not be treated as a product UI generator.

## Implementation boundaries

Generated auth helpers are frontend session utilities; backend capabilities remain responsible for authorization. Client-side route guards are view-level UX helpers, not security controls. The Next.js template is a starter shell, not a complete production application, and it does not emit per-capability pages. Generated hooks use React state/effect directly rather than TanStack Query. Form hints are extracted from `capability.input`, not from entity definitions. Contract-derived generated files should be regenerated rather than edited manually.
