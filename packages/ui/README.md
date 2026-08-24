# @plumbus/ui

UI source-code generation for the Plumbus framework.

`@plumbus/ui` turns Plumbus capability contracts, flow trigger descriptors, auth configuration, capability input schemas, Next.js template configuration, and translation definitions into frontend source files. The package is primarily a generator package: it does not provide a visual component library, application shell runtime, or production UI kit.

The package also exposes thin `next-intl` re-export subpaths used by generated i18n code:

```ts
import { NextIntlClientProvider, useFormatter, useTranslations } from "@plumbus/ui/next-intl";
import { getFormatter, getRequestConfig, getTranslations } from "@plumbus/ui/next-intl-server";
```

Generated source should be reviewed, committed, and owned by the consuming application.

## Install

```bash
pnpm add @plumbus/ui
```

The package depends on `@plumbus/core` for Plumbus types and definitions. Generator callers normally pass `CapabilityContract` and `TranslationDefinition` values from `@plumbus/core`.

## What it generates

### Typed API clients

Use `generateClientModule` to generate a complete fetch-based client module from capability contracts and flow triggers.

```ts
import { generateClientModule } from "@plumbus/ui";

const clientCode = generateClientModule(capabilities, flows, {
  baseUrl: "",
  includeJsDoc: true,
});
```

The generated client module contains shared API error helpers, TypeScript aliases for each HTTP-exposed (`exposeAs: ['api']`) capability input/output schema, one fetch function per those capabilities, and one trigger function per flow descriptor. Capabilities without `exposeAs: ['api']` are omitted, as are event handlers. Query capabilities are emitted as `GET` requests with query parameters. Action and job capabilities are emitted as `POST` requests with JSON request bodies.

### React hooks

Use `generateHooksModule` to generate small React hooks for capability clients.

```ts
import { generateHooksModule } from "@plumbus/ui";

const hooksCode = generateHooksModule(capabilities, {
  toastImport: "sonner",
});
```

Generated query hooks call the generated client from `useEffect` and expose `{ data, loading, error }`. Generated mutation hooks expose `mutate(input)`, `reset()`, and the same state fields. They use React `useState` and `useEffect` directly; they are not TanStack Query hooks.

### Auth helpers

Use `generateAuthModule` to generate frontend session helpers.

```ts
import { generateAuthModule } from "@plumbus/ui";

const authCode = generateAuthModule({
  provider: "jwt",
  tokenKey: "plumbus_auth_token",
  loginEndpoint: "/api/auth/login",
  logoutEndpoint: "/api/auth/logout",
  refreshEndpoint: "/api/auth/refresh",
  multiTenant: false,
});
```

The generated module includes auth types, token helpers, login/logout/session-refresh functions, React auth hooks, a `RouteGuard`, and optional tenant helpers. The `provider` field is part of the config shape, but the current generator does not branch on provider type; generated behavior is driven by endpoints, token storage, and the `multiTenant` flag.

The generated token helpers store bearer tokens in `localStorage`. This is frontend session scaffolding, not backend authorization. Backend capability access policies must remain authoritative.

### Form hints

Use `extractFormHints` or `generateFormHintsModule` to derive form metadata from capability input schemas.

```ts
import { extractFormHints, generateFormHintsModule } from "@plumbus/ui";

const hints = extractFormHints(createUserCapability);
const formHintsCode = generateFormHintsModule(capabilities);
```

Form hints are extracted from `capability.input` when it is a Zod object schema. The generator does not read entity definitions and does not produce final form components. Applications use the hints as structured metadata for labels, field types, enum options, defaults, and validation hints.

### Next.js starter scaffold

Use `generateNextjsTemplate` to generate a starter Next.js App Router shell.

```ts
import { generateNextjsTemplate, generateCapabilityPage } from "@plumbus/ui";

const files = generateNextjsTemplate({
  appName: "My App",
  auth: true,
  apiBaseUrl: "https://api.example.com",
});

const examplePage = generateCapabilityPage(getUserCapability);
```

`apiBaseUrl` is required (CLI: `--api-base-url`, or `NEXT_PUBLIC_API_BASE_URL` / `API_BASE_URL`). No default API port is assumed.

`generateNextjsTemplate` emits a starter shell: `package.json`, `tsconfig.json`, Tailwind/PostCSS files, `.env.local`, app layout, home/loading/error pages, `proxy.ts`, placeholder `hooks/` and `lib/` directories, and auth pages/components when auth is enabled.

It does not generate per-capability pages as part of the template. Use `generateCapabilityPage(capability)` separately for minimal example pages.

The generated `package.json` contains scripts and empty dependency objects. The consuming app, workspace, or CLI wrapper is responsible for dependency management.

### Translation modules

Use `generateTranslationModule` to generate `next-intl`-oriented i18n files from Plumbus translation definitions.

```ts
import { generateTranslationModule } from "@plumbus/ui";

const files = generateTranslationModule(translationDefinitions, {
  splitLocaleBundles: false,
  serverLocaleCookie: false,
});
```

The generator emits message catalogs, locale config, typed keys (`I18nKey` / `MessageKeyOf` / `Messages` / `Namespace`), an opaque `TranslatedText` brand (`i18n/translated-text.ts`), a `next-intl` `AppConfig` file (`i18n/global.ts`), request config, a provider component (with missing-key fallback sentinel), and a catalog-typed `useTranslations` wrapper plus `useFormatter`. `t` / `markup` return `TranslatedText` (type re-exported from `i18n/index.ts`; the brander is emit-internal). It expands dotted message keys into nested message objects for `next-intl` and tracks known RTL locales such as Hebrew and Arabic.

Generated i18n source intentionally imports `@plumbus/ui/next-intl` and `@plumbus/ui/next-intl-server`, which are thin package re-exports of `next-intl` APIs.

## Public exports

The package exports these generator groups:

```ts
import {
  // client + hook generation
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

  // auth generation
  generateAuthFunctions,
  generateAuthModule,
  generateAuthTypes,
  generateRouteGuard,
  generateTenantContext,
  generateTokenUtils,
  generateUseAuthHook,
  generateUseCurrentUserHook,

  // form generation
  extractFieldHint,
  extractFormHints,
  generateFormHintsCode,
  generateFormHintsModule,

  // Next.js template generation
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

  // translation generation
  generateTranslationModule,
} from "@plumbus/ui";
```

Public type exports are available for generator inputs and generated file descriptors:

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

## Instruction files

This package ships instruction files for automated coding tools:

```text
node_modules/@plumbus/ui/instructions/
├── framework.md
├── client-generator.md
├── auth-generator.md
├── form-generator.md
├── nextjs-template.md
├── translation-generator.md
├── patterns.md
└── testing.md
```

These files describe how to use the generator package safely and how to avoid treating generated frontend helpers as backend authority.

## Related Plumbus packages

`@plumbus/ui` is one package in the Plumbus framework. For the full list of packages and when to use each, see the [Plumbus monorepo README](https://github.com/plumbus-framework/plumbus#packages).

## License

MIT
