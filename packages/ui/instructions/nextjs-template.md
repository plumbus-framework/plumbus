# Next.js Template Generator

Scaffolds a complete Next.js 16+ project wired to a Plumbus backend — layout, pages, auth, proxy, error boundary, and environment config.

## Configuration

```ts
interface NextjsTemplateConfig {
  appName: string;          // Application display name
  auth?: boolean;           // Include auth wiring (default: true)
  apiBaseUrl?: string;      // Backend URL (default: "http://localhost:3000")
}

interface GeneratedFile {
  path: string;     // Relative file path within the project
  content: string;  // File contents
}
```

## Full Scaffold

### `generateNextjsTemplate(config, capabilities?)`

Returns `GeneratedFile[]` — a complete Next.js project. Write each file to disk:

```ts
const files = generateNextjsTemplate(
  { appName: "My App", auth: true, apiBaseUrl: "http://localhost:3000" },
  [getUser, createUser],
);

for (const file of files) {
  writeFileSync(join(outputDir, file.path), file.content);
}
```

### Generated Project Structure

```
package.json                          # Next.js 16, React 19, TypeScript 5, Tailwind CSS 4
tsconfig.json                         # Strict, bundler module resolution
postcss.config.mjs                    # PostCSS config with @tailwindcss/postcss
.env.local                            # API base URL, auth flag, secrets
proxy.ts                              # Auth token check, protected paths (Next.js 16+)
app/
  globals.css                         # Tailwind import + base resets
  layout.tsx                          # Root layout (with AuthProvider if auth)
  page.tsx                            # Home page
  loading.tsx                         # Global loading skeleton
  error.tsx                           # Global error boundary
  login/page.tsx                      # Login page (if auth enabled)
  signup/page.tsx                     # Signup page (if auth enabled)
components/
  AuthProvider.tsx                    # Context-based auth provider (if auth)
hooks/
  .gitkeep                            # Placeholder for custom hooks (hooks.ts generated here)
lib/
  .gitkeep                            # Placeholder for lib modules (client.ts, auth.ts, form-hints.ts generated here)
```

## Individual File Generators

### `generatePackageJson(config)`

```json
{
  "name": "{kebab-case-app-name}",
  "dependencies": { "next": "^14", "react": "^18", "react-dom": "^18", "tailwindcss": "^4", "@tailwindcss/postcss": "^4" },
  "devDependencies": { "typescript": "^5", "@types/react": "^18", "@types/react-dom": "^18" }
}
```

### `generateTsConfig()`

Strict TypeScript config for Next.js: `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, path alias `@/*`.

### `generateGlobalsCss()`

Minimal `app/globals.css` with Tailwind CSS import and base resets (box-sizing, margin, antialiased text). Apps customize by extending this file with their own theme tokens.

### `generatePostcssConfig()`

PostCSS config at `postcss.config.mjs` with `@tailwindcss/postcss` plugin. Required for Tailwind CSS 4 processing.

### `generateLayout(config)`

Root layout with `<html>` + `<body>`. Imports `./globals.css` for Tailwind styles. If `auth !== false`, wraps children in `<AuthProvider>`.

### `generateHomePage(config)`

Simple welcome page with app name and description text.

### `generateCapabilityPage(cap)`

Route: `app/{kebab-name}/page.tsx`

Generated page depends on capability kind:

| Kind | UI Pattern |
|------|-----------|
| `query` | Auto-fetches with `use{Name}({})`, shows loading/error/data states |
| `action`/`job` | Form with `handleSubmit`, uses `use{Name}()` mutation hook, shows submit/loading/error/result |

All pages use `"use client"` directive and import hooks from `@/hooks/hooks`.

### `generateAuthProvider()`

Context-based provider at `components/AuthProvider.tsx`:
- Creates `AuthContext` with `AuthState`.
- On mount: checks stored token, refreshes session.
- Exports `useAuthContext()` hook.
- Imports from `@/lib/auth`.

### `generateProxy(config)`

Next.js proxy at `proxy.ts` (replaces the deprecated `middleware.ts` in Next.js 16+):
- When auth enabled: checks `auth_token` cookie for protected paths (`/dashboard`, `/settings`).
- Redirects to `/login` if no token.
- Exports a `proxy` function (not `middleware`).
- Matcher excludes `_next/static`, `_next/image`, and `favicon.ico`.

### `generateLoginPage()`

Login page at `app/login/page.tsx`:
- Client component with email/password form.
- Uses `login()` from `@/lib/auth`.
- Links to signup page.

### `generateSignupPage()`

Signup page at `app/signup/page.tsx`:
- Client component with name/email/password form.
- Posts to the backend signup endpoint.
- Links to login page.

### `generateEnvLocal(config)`

Environment variables template:
```env
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_AUTH_ENABLED=true
AUTH_SECRET=change-me-in-production
```

### `generateErrorBoundary()`

Client error component at `app/error.tsx` — logs error, shows message, provides retry button.

### `generateLoadingComponent()`

Loading skeleton at `app/loading.tsx` with `role="status"` and `aria-label="Loading"`.

### `generatePlaceholderFiles()`

Returns `hooks/.gitkeep` and `lib/.gitkeep`.

## Auth Integration

When `auth: true` (default):
1. `AuthProvider` wraps the app layout.
2. Proxy protects configured paths.
3. Login and signup pages are generated.
4. Generated code can use `useAuthContext()`.

When `auth: false`:
- No `AuthProvider` import in layout.
- Proxy runs but skips auth checks.
- No login/signup pages generated.
- Pages still work for public capabilities.
