# Auth Generator

Generates frontend authentication utilities — types, token management, login/logout functions, React hooks, a route guard component, and optional multi-tenant support.

## Configuration

```ts
interface AuthHelperConfig {
  /** Auth provider type (e.g. "jwt", "oauth") */
  provider: string;
  /** localStorage key for token (default: "plumbus_auth_token") */
  tokenKey?: string;
  /** Login endpoint (default: "/api/auth/login") */
  loginEndpoint?: string;
  /** Logout endpoint (default: "/api/auth/logout") */
  logoutEndpoint?: string;
  /** Session refresh endpoint (default: "/api/auth/refresh") */
  refreshEndpoint?: string;
  /** Enable tenant context provider (default: false) */
  multiTenant?: boolean;
}
```

## Individual Generators

### `generateAuthTypes()`

Produces core TypeScript interfaces used across auth code:

| Type | Fields |
|------|--------|
| `AuthUser` | `userId`, `roles`, `scopes`, `tenantId?`, `provider`, `sessionId?` |
| `AuthState` | `user`, `isAuthenticated`, `isLoading`, `error` |
| `AuthActions` | `login()`, `logout()`, `refreshSession()`, `getToken()` |
| `LoginCredentials` | `email?`, `password?`, `token?`, `provider?` |
| `AuthConfig` | `loginEndpoint`, `logoutEndpoint`, `refreshEndpoint`, `tokenKey` |

### `generateTokenUtils(config?)`

Token storage utilities for browser environments:

| Function | Purpose |
|----------|---------|
| `getStoredToken()` | Read token from `localStorage` (returns `null` on server) |
| `setStoredToken(token)` | Persist token to `localStorage` |
| `clearStoredToken()` | Remove token from `localStorage` |
| `parseJwtPayload(token)` | Decode JWT payload (base64url → JSON) |
| `isTokenExpired(token)` | Check `exp` claim against `Date.now()` |

- Uses the configurable `tokenKey` (default: `"plumbus_auth_token"`).
- All functions guard against SSR with `typeof window === "undefined"`.

### `generateAuthFunctions(config?)`

HTTP-based auth operations:

| Function | HTTP | Endpoint |
|----------|------|----------|
| `login(credentials)` | POST | `{loginEndpoint}` |
| `logout()` | POST | `{logoutEndpoint}` |
| `refreshSession()` | POST | `{refreshEndpoint}` |
| `getAuthHeaders()` | — | Returns `{ Authorization: "Bearer ..." }` or `{}` |

- `login` stores the returned token and returns `AuthUser`.
- `logout` calls the endpoint (fire-and-forget) then clears the stored token.
- `refreshSession` returns `AuthUser | null` — clears token on failure.

### `generateUseAuthHook()`

Full React hook combining state and actions:

```ts
function useAuth(): AuthState & AuthActions
```

- On mount: checks stored token, refreshes session if valid, sets loading state.
- Returns `{ user, isAuthenticated, isLoading, error, login, logout, refreshSession, getToken }`.
- `login` and `logout` update state and re-render.

### `generateUseCurrentUserHook()`

Simplified read-only hook:

```ts
function useCurrentUser(): { user: AuthUser | null; isAuthenticated: boolean; isLoading: boolean }
```

Delegates to `useAuth()` internally.

### `generateRouteGuard()`

Role/scope-based route protection component:

```ts
interface RouteGuardProps {
  children: React.ReactNode;
  roles?: string[];       // User must have at least one of these roles
  scopes?: string[];      // User must have at least one of these scopes
  fallback?: React.ReactNode;  // Shown while loading or when unauthorized
  redirectTo?: string;    // Redirect URL for unauthenticated users
}
```

Behavior:
1. While loading → render `fallback` (or null).
2. Not authenticated → redirect if `redirectTo` set, else render `fallback`.
3. Roles check → `some` match (any role matches → pass).
4. Scopes check → `some` match (any scope matches → pass).
5. Authorized → render `children`.

### `generateTenantContext()`

Multi-tenant context hook (only included when `config.multiTenant` is true):

```ts
interface TenantContextValue {
  tenantId: string | null;
  setTenantId(id: string): void;
}

function useTenant(): TenantContextValue
```

- Initializes `tenantId` from the authenticated user's `tenantId`.
- Syncs when user identity changes.

## Module Generator

### `generateAuthModule(config?)`

Combines all auth generators into a single file:

```ts
const code = generateAuthModule({
  provider: "jwt",
  tokenKey: "my_app_token",
  loginEndpoint: "/api/v1/auth/login",
  multiTenant: true,
});
// Write to: generated/auth.ts
```

Output order: imports → types → token utils → auth functions → useAuth → useCurrentUser → RouteGuard → (tenant context if enabled).

Imports `React`, `useState`, `useEffect` from React.

## Auth Flow

```
Login:   credentials → POST /api/auth/login → { token, user } → localStorage
Refresh: token → POST /api/auth/refresh → { token, user } → localStorage
Logout:  token → POST /api/auth/logout → clear localStorage
Request: getAuthHeaders() → { Authorization: "Bearer <token>" }
```
