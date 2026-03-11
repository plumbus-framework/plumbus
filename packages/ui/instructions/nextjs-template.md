# Next.js Template Generator

Scaffolds a complete Next.js 14 project wired to a Plumbus backend — layout, pages, auth, middleware, API proxy, error boundary, and environment config.

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
package.json                          # Next.js 14, React 18, TypeScript 5
tsconfig.json                         # Strict, bundler module resolution
.env.local                            # API base URL, auth flag, secrets
middleware.ts                          # Auth token check, protected paths
app/
  layout.tsx                          # Root layout (with AuthProvider if auth)
  page.tsx                            # Home page
  loading.tsx                         # Global loading skeleton
  error.tsx                           # Global error boundary
  {capability-slug}/page.tsx          # Per-capability pages (query or action)
  api/plumbus/[...path]/route.ts      # API proxy to Plumbus backend
components/
  AuthProvider.tsx                    # Context-based auth provider (if auth)
generated/
  .gitkeep                            # Placeholder for generated client files
hooks/
  .gitkeep                            # Placeholder for custom hooks
```

## Individual File Generators

### `generatePackageJson(config)`

```json
{
  "name": "{kebab-case-app-name}",
  "dependencies": { "next": "^14", "react": "^18", "react-dom": "^18" },
  "devDependencies": { "typescript": "^5", "@types/react": "^18", "@types/react-dom": "^18" }
}
```

### `generateTsConfig()`

Strict TypeScript config for Next.js: `target: "ES2017"`, `module: "esnext"`, `moduleResolution: "bundler"`, `jsx: "preserve"`, path alias `@/*`.

### `generateLayout(config)`

Root layout with `<html>` + `<body>`. If `auth !== false`, wraps children in `<AuthProvider>`.

### `generateHomePage(config)`

Simple welcome page with app name and description text.

### `generateCapabilityPage(cap)`

Route: `app/{kebab-name}/page.tsx`

Generated page depends on capability kind:

| Kind | UI Pattern |
|------|-----------|
| `query` | Auto-fetches with `use{Name}({})`, shows loading/error/data states |
| `action`/`job` | Form with `handleSubmit`, uses `use{Name}()` mutation hook, shows submit/loading/error/result |

All pages use `"use client"` directive and import hooks from `@/generated/hooks`.

### `generateAuthProvider()`

Context-based provider at `components/AuthProvider.tsx`:
- Creates `AuthContext` with `AuthState`.
- On mount: checks stored token, refreshes session.
- Exports `useAuthContext()` hook.
- Imports from `@/generated/auth`.

### `generateMiddleware(config)`

Next.js middleware at `middleware.ts`:
- When auth enabled: checks `auth_token` cookie for protected paths (`/dashboard`, `/settings`, `/api/protected`).
- Redirects to `/login` if no token.
- Matcher excludes `_next/static`, `_next/image`, and `favicon.ico`.

### `generateApiRouteHelper(config)`

Catch-all API proxy at `app/api/plumbus/[...path]/route.ts`:
- Forwards requests to `{apiBaseUrl}/{path}`.
- Preserves auth headers, query parameters, and request method.
- Supports GET, POST, PUT, PATCH, DELETE.

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

Returns `generated/.gitkeep` and `hooks/.gitkeep`.

## Auth Integration

When `auth: true` (default):
1. `AuthProvider` wraps the app layout.
2. Middleware protects configured paths.
3. Generated pages can use `useAuthContext()`.
4. API proxy forwards `Authorization` headers.

When `auth: false`:
- No `AuthProvider` import in layout.
- Middleware runs but skips auth checks.
- Pages still work for public capabilities.
