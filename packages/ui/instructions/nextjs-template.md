# Next.js Template Generator

The Next.js template generator creates a starter App Router shell for a Plumbus frontend.

It is not a complete production application generator. It creates the baseline files needed for an app shell and leaves contract-derived modules such as `lib/client.ts`, `hooks/hooks.ts`, `lib/auth.ts`, and `lib/form-hints.ts` to the corresponding module generators or CLI wrapper.

## Configuration

```ts
interface NextjsTemplateConfig {
  appName: string;
  auth?: boolean;
  /** Required for `.env.local`. No localhost port default. */
  apiBaseUrl?: string;
}

interface GeneratedFile {
  path: string;
  content: string;
}
```

## `generateNextjsTemplate(config, _capabilities?)`

```ts
import { generateNextjsTemplate } from "@plumbus/ui";

const files = generateNextjsTemplate({
  appName: "My App",
  auth: true,
  apiBaseUrl: "https://api.example.com",
});
```

Signature:

```ts
function generateNextjsTemplate(
  config: NextjsTemplateConfig,
  _capabilities?: CapabilityContract[],
): GeneratedFile[];
```

The `_capabilities` argument in this implementation exists in the function signature but is ignored. Passing capabilities to `generateNextjsTemplate` does not generate capability pages.

## Generated project structure

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
  login/page.tsx      # only when auth !== false
  signup/page.tsx     # only when auth !== false
components/
  AuthProvider.tsx    # only when auth !== false
hooks/
  .gitkeep
lib/
  .gitkeep
```

## Individual file generators

### `generatePackageJson(config)`

Generates a minimal `package.json`:

```json
{
  "name": "{kebab-case-app-name}",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {},
  "devDependencies": {}
}
```

The generator emits empty dependency objects on purpose. `@plumbus/ui` supplies `next`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `tailwindcss`, `@tailwindcss/postcss` and `typescript`; the app adds `@plumbus/ui` (and `next-intl`, a peer) and never declares those packages itself, so a Plumbus upgrade is what moves them, security fixes included. A second declaration in the app pins its own copy, which keeps an old version after the framework moves on and can put two copies of Next or React in one build.

With pnpm, an app reaches a dependency's dependencies only when they are hoisted. List them under `publicHoistPattern` in the app's `pnpm-workspace.yaml` (`plumbus create --monorepo` writes this):

```yaml
publicHoistPattern:
  - next
  - react
  - react-dom
  - '@types/react'
  - '@types/react-dom'
  - tailwindcss
  - '@tailwindcss/postcss'
  - typescript
```

npm and Yarn's `node-modules` linker hoist them already. `plumbus ui deps` checks all of this on demand (no declared copy, hoisted, one locked version each).

### `generateTsConfig()`

Generates a strict TypeScript config for a Next.js app with bundler module resolution, JSX preservation, incremental builds, and the `@/*` path alias.

### `generateGlobalsCss()`

Generates `app/globals.css` with Tailwind import and minimal base resets.

### `generatePostcssConfig()`

Generates `postcss.config.mjs` with `@tailwindcss/postcss`.

### `generateLayout(config)`

Generates `app/layout.tsx`.

When `auth !== false`, the layout imports `AuthProvider` from `../components/AuthProvider` and wraps `children` with it.

### `generateHomePage(config)`

Generates a simple `app/page.tsx` with the configured app name and a welcome message.

### `generateAuthProvider()`

Generates `components/AuthProvider.tsx`.

The generated provider:

- creates an auth context;
- reads the stored token on mount;
- checks token expiry;
- calls `refreshSession()` from `@/lib/auth`;
- exposes `useAuthContext()`.

This file expects a generated or app-provided `@/lib/auth` module.

### `generateProxy(config)`

Generates `proxy.ts` using the Next.js proxy convention.

The current proxy does not enforce route authorization. It returns `NextResponse.next()` and includes an explicit comment explaining that generated tokens are stored in `localStorage`, which is not readable by Next.js proxy/middleware.

Backend Plumbus capability policies remain authoritative. If an app needs edge route gating, it must move the token/session to an HttpOnly cookie or another server-readable mechanism and validate it server-side.

### `generateLoginPage()`

Generates `app/login/page.tsx`.

The generated page:

- is a client component;
- renders an email/password form;
- calls `login()` from `@/lib/auth`;
- redirects to `/` after successful login;
- links to `/signup`.

### `generateSignupPage()`

Generates `app/signup/page.tsx`.

The generated page:

- is a client component;
- renders a name/email/password form;
- posts directly to `${NEXT_PUBLIC_API_BASE_URL}/api/auth/signup`;
- redirects to `/login` after successful signup;
- links to `/login`.

### `generateEnvLocal(config)`

`apiBaseUrl` is required. There is no localhost port default. CLI wrappers must pass `--api-base-url` or set `NEXT_PUBLIC_API_BASE_URL` / `API_BASE_URL`. The file writes that URL into `.env.local`:

```env
NEXT_PUBLIC_API_BASE_URL=https://api.example.com
NEXT_PUBLIC_AUTH_ENABLED=true
AUTH_SECRET=change-me-in-production
# DATABASE_URL=  # from the host environment — do not invent a port here
```

### `generateErrorBoundary()`

Generates `app/error.tsx`, a client error component that logs the error, displays the message, and renders a retry button.

### `generateLoadingComponent()`

Generates `app/loading.tsx` with a minimal loading state using `role="status"` and `aria-label="Loading"`.

### `generatePlaceholderFiles()`

Returns:

```text
hooks/.gitkeep
lib/.gitkeep
```

## Capability pages

`generateCapabilityPage(cap)` is a separate helper and is not automatically used by `generateNextjsTemplate`.

```ts
import { generateCapabilityPage } from "@plumbus/ui";

const page = generateCapabilityPage(getUserCapability);
```

It returns one `GeneratedFile`:

```text
app/{kebab-capability-name}/page.tsx
```

Generated query pages call the generated query hook with `{}`. Generated action/job pages render a minimal form and call the generated mutation hook.

These pages are examples and usually require app-specific UX work before production use.

## Auth integration

When `auth !== false`, `generateNextjsTemplate` includes:

- `components/AuthProvider.tsx`;
- `app/login/page.tsx`;
- `app/signup/page.tsx`;
- layout wrapping with `AuthProvider`.

When `auth: false`, those auth files are omitted and the layout does not import or wrap with `AuthProvider`.

`proxy.ts` is still generated in both cases.
