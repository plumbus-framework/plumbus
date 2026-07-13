# UI Code Generation

The `@plumbus/ui` package generates frontend source code from Plumbus definitions. It exists to keep application frontends aligned with backend contracts without turning Plumbus into a visual UI framework.

Generated output is ordinary TypeScript, React, and Next.js source that the consuming application writes to disk, reviews, and imports. The exception is the i18n integration: generated translation files intentionally import `@plumbus/ui/next-intl` and `@plumbus/ui/next-intl-server`, which are thin re-export subpaths for `next-intl` APIs.

## Scope

The package covers the contract-sensitive parts of a Plumbus frontend: typed API clients, React hooks, flow trigger functions, frontend auth helpers, form hints, a starter Next.js App Router shell, and translation modules. These outputs are useful because they are derived from Plumbus definitions instead of being hand-written from memory.

The package does not generate a complete product UI, reusable visual components, TanStack Query hooks, a Next.js API proxy route, backend authorization enforcement, or per-capability pages as part of `generateNextjsTemplate`. It can generate minimal example capability pages through `generateCapabilityPage(capability)`, but those pages are scaffolding rather than product-ready UX.

Backend capability policies remain authoritative. Frontend guards help the interface show the right screens, but they do not secure the backend.

## Overview

```text
Plumbus definitions                         Generated frontend source
────────────────────                         ─────────────────────────
Capability contracts  ───────────────────▶   lib/client.ts
                                             hooks/hooks.ts

Flow trigger inputs  ────────────────────▶   start{FlowName}(...)

Auth configuration   ────────────────────▶   lib/auth.ts

Capability input Zod schemas ────────────▶   lib/form-hints.ts

Next.js template config ─────────────────▶   app/, components/, lib/, hooks/

Translation definitions ─────────────────▶   i18n/messages.ts, config.ts, keys.ts,
                                             global.ts, request.ts, provider.tsx, index.ts
```

## Public API

The public generator API is exported from `packages/ui/src/index.ts`.

### Client and hook generators

```ts
import {
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
} from "@plumbus/ui";
```

### Auth generators

```ts
import {
  generateAuthFunctions,
  generateAuthModule,
  generateAuthTypes,
  generateRouteGuard,
  generateTenantContext,
  generateTokenUtils,
  generateUseAuthHook,
  generateUseCurrentUserHook,
} from "@plumbus/ui";
```

### Form generators

```ts
import {
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,
} from "@plumbus/ui";
```

### Next.js template generators

```ts
import {
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
} from "@plumbus/ui";
```

### Translation generator

```ts
import { generateTranslationModule } from "@plumbus/ui";
```

### Type exports

```ts
import type {
  AuthHelperConfig,
  ClientGeneratorConfig,
  FlowTriggerInput,
  FormFieldHint,
  FormFieldType,
  FormHints,
  FormValidation,
  GeneratedFile,
  GeneratedTranslationFile,
  NextjsTemplateConfig,
  TranslationGeneratorOptions,
} from "@plumbus/ui";
```

## Client module generation

Use `generateClientModule` when an application needs a single frontend client file for capabilities and flow triggers.

```ts
import { generateClientModule } from "@plumbus/ui";

const source = generateClientModule(capabilities, flows, {
  baseUrl: "",
  includeJsDoc: true,
});
```

```ts
function generateClientModule(
  capabilities: CapabilityContract[],
  flows: FlowTriggerInput[],
  config?: ClientGeneratorConfig,
): string;
```

The generated client file starts with shared Plumbus API error helpers, then emits `{PascalName}Input` and `{PascalName}Output` aliases for each capability. After the types, it emits one fetch function per capability and one trigger function per flow descriptor.

For a query capability named `getUser` in domain `users`, the generated client function is named `getUser` and sends a `GET` request to `/api/users/get-user`. Inputs are serialized through `URLSearchParams`. Action and job capabilities use `POST` and send `JSON.stringify(input)` in the request body.

Each generated client function accepts optional request headers and an abort signal:

```ts
await getUser(
  { userId: "u-1" },
  {
    headers: { Authorization: "Bearer token" },
    signal: abortController.signal,
  },
);
```

Flow trigger generation is intentionally narrow. A flow descriptor produces a function named `start{PascalFlowName}` that posts to `/api/{domain}/{kebab-flow-name}/start` and returns `{ executionId: string; status: string }`. The package does not yet generate flow-status polling, timelines, approvals, wait/resume controls, or retry controls.

## React hook generation

Use `generateHooksModule` to generate hooks that call the generated client module.

```ts
import { generateHooksModule } from "@plumbus/ui";

const source = generateHooksModule(capabilities, {
  toastImport: "sonner",
});
```

```ts
function generateHooksModule(
  capabilities: CapabilityContract[],
  config?: ClientGeneratorConfig,
): string;
```

Query hooks fetch automatically when mounted and when `JSON.stringify(input)` changes:

```tsx
const { data, loading, error } = useGetUser({ userId: "u-1" });
```

Mutation hooks are manual and expose a `mutate` function:

```tsx
const { mutate, data, loading, error, reset } = useCreateUser();
await mutate({ name: "Alice" });
```

These hooks are deliberately small. They manage local state with `useState` and `useEffect`, call `options.onError(error)` when provided, and otherwise call `toast.error(error.message)`. Applications that need caching, retries, invalidation, pagination, or request deduplication should wrap the generated clients with a data-fetching layer such as TanStack Query instead of expecting those concerns from this generator.

## Auth generation

Use `generateAuthModule` to generate frontend session helpers.

```ts
import { generateAuthModule } from "@plumbus/ui";

const source = generateAuthModule({
  provider: "jwt",
  tokenKey: "plumbus_auth_token",
  loginEndpoint: "/api/auth/login",
  logoutEndpoint: "/api/auth/logout",
  refreshEndpoint: "/api/auth/refresh",
  multiTenant: false,
});
```

```ts
function generateAuthModule(config?: AuthHelperConfig): string;
```

The generated module contains auth types, token utilities, login/logout/session-refresh functions, `getAuthHeaders()`, `useAuth()`, `useCurrentUser()`, a client-side `RouteGuard`, and tenant helpers when `multiTenant: true`.

The `provider` field is part of the config shape, but the current generator does not branch on provider type. Endpoint configuration, token key configuration, and the `multiTenant` flag are the parts that change generated behavior.

### Security posture

The generated auth module stores bearer tokens in `localStorage`. This makes the helpers simple to use in client-side scaffolding, but it also means tokens are readable by JavaScript and are not available to Next.js proxy/middleware. `RouteGuard` is therefore a view-level UX helper only.

Applications must continue to enforce authorization in backend Plumbus capabilities and policies. Production applications that require server-readable sessions should replace or adapt the generated token storage with an HttpOnly cookie or another server-side session mechanism.

## Form hint generation

Use form hint generators to extract UI metadata from capability input schemas.

```ts
import { extractFormHints, generateFormHintsModule } from "@plumbus/ui";

const hints = extractFormHints(createUserCapability);
const source = generateFormHintsModule(capabilities);
```

`extractFormHints(capability)` reads `capability.input`. When the input is a Zod object schema, the generator emits one `FormFieldHint` per object field. If the input is not a Zod object schema, the returned `fields` array is empty.

The generator is intentionally metadata-oriented. It suggests field labels, field types, enum options, defaults, descriptions, and validation hints; it does not produce final form UI and it does not read entity definitions.

```ts
interface FormHints {
  capabilityName: string;
  kind: string;
  fields: FormFieldHint[];
}

interface FormFieldHint {
  name: string;
  label: string;
  fieldType: "text" | "number" | "boolean" | "select" | "textarea" | "date" | "hidden";
  required: boolean;
  defaultValue?: unknown;
  zodType: string;
  options?: string[];
  validation: FormValidation;
  description?: string;
}
```

The implementation unwraps optional, nullable, and defaulted Zod wrappers; maps common Zod types to form field types; extracts enum options; and reads validation hints such as min/max, minLength/maxLength, regex, email, and URL checks.

## Next.js template generation

Use `generateNextjsTemplate` for a starter Next.js App Router shell.

```ts
import { generateNextjsTemplate } from "@plumbus/ui";

const files = generateNextjsTemplate({
  appName: "My App",
  auth: true,
  apiBaseUrl: "http://localhost:3000",
});
```

```ts
function generateNextjsTemplate(
  config: NextjsTemplateConfig,
  _capabilities?: CapabilityContract[],
): GeneratedFile[];
```

The `_capabilities` parameter exists in the function signature but is ignored by the implementation. Passing capabilities to `generateNextjsTemplate` does not cause capability pages to be emitted.

Generated structure:

```text
package.json
postcss.config.mjs
tsconfig.json
.env.local
proxy.ts
app/
  globals.css
  layout.tsx
  page.tsx
  loading.tsx
  error.tsx
  login/page.tsx      # when auth !== false
  signup/page.tsx     # when auth !== false
components/
  AuthProvider.tsx    # when auth !== false
hooks/
  .gitkeep
lib/
  .gitkeep
```

The generated `package.json` contains scripts and empty `dependencies` / `devDependencies` objects. Dependency installation is the responsibility of the consuming app, workspace, or CLI wrapper.

`generateCapabilityPage(capability)` exists as a separate helper. It returns a single `GeneratedFile` for `app/{kebab-capability-name}/page.tsx`. Query pages call the corresponding generated query hook with `{}`. Action/job pages render a minimal form and call the corresponding mutation hook. These pages are best treated as examples or starting points.

## Translation generation

Use `generateTranslationModule` to generate `next-intl`-oriented i18n source files.

```ts
import { generateTranslationModule } from "@plumbus/ui";

const files = generateTranslationModule(definitions, {
  splitLocaleBundles: false,
  serverLocaleCookie: false,
});
```

```ts
function generateTranslationModule(
  definitions: TranslationDefinition[],
  options?: TranslationGeneratorOptions,
): GeneratedTranslationFile[];
```

If no definitions are provided, the function returns an empty array.

Default output:

```text
i18n/messages.ts
i18n/config.ts
i18n/keys.ts
i18n/global.ts
i18n/request.ts
i18n/provider.tsx
i18n/index.ts
```

With `splitLocaleBundles: true`, the generator also emits one bundle per locale and makes `i18n/messages.ts` aggregate those bundles:

```text
i18n/locales/{locale}.ts
i18n/messages.ts
i18n/config.ts
i18n/keys.ts
i18n/global.ts
i18n/request.ts
i18n/provider.tsx
i18n/index.ts
```

Dotted message keys are expanded into nested message objects because `next-intl` resolves nested paths. The generated provider persists the selected locale, updates `document.documentElement.lang`, and sets `document.documentElement.dir` to `rtl` for known RTL locales such as `ar`, `he`, `fa`, `ur`, `ps`, `sd`, and `yi`. Generated `i18n/index.ts` exports a catalog-typed `useTranslations` wrapper (prefer it over importing hooks from `@plumbus/ui/next-intl` directly).

`serverLocaleCookie: true` makes the generated request config read the `plumbus-ui-locale` cookie server-side after `requestLocale`. This uses a Next.js Dynamic API, opts routes into dynamic rendering, and is not suitable for static export.

Generated translation files intentionally depend on the package's `@plumbus/ui/next-intl` and `@plumbus/ui/next-intl-server` subpaths.

## CLI integration

This package exposes generator functions. A CLI wrapper may call those functions and write the returned source strings or `GeneratedFile[]` outputs into a frontend project.

When documenting CLI behavior, keep CLI-specific claims in the CLI documentation and keep this page focused on the generator API. Typical generated destinations are:

```text
frontend/lib/client.ts
frontend/hooks/hooks.ts
frontend/lib/auth.ts
frontend/lib/form-hints.ts
frontend/i18n/*
```

Contract-derived files such as `lib/client.ts`, `hooks/hooks.ts`, `lib/auth.ts`, `lib/form-hints.ts`, and `i18n/*` should be treated as generated output and regenerated rather than edited manually. Application-specific pages, components, layouts, and styles remain ordinary frontend code owned by the app.
