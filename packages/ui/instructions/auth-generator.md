# Auth Generator

The auth generator produces frontend authentication helper source code.

It is intended for frontend session scaffolding: auth types, token storage helpers, login/logout/session-refresh functions, React auth hooks, a route guard component, and optional tenant helpers.

It does not replace backend authorization. Plumbus backend capabilities and policies remain authoritative.

## Configuration

```ts
interface AuthHelperConfig {
  provider: string;
  tokenKey?: string;
  loginEndpoint?: string;
  logoutEndpoint?: string;
  refreshEndpoint?: string;
  multiTenant?: boolean;
}
```

The `provider` field is required by the config type, but the current generator does not branch on provider type. Generated behavior changes through endpoint options, token-key configuration, and `multiTenant`.

Defaults used by the generator:

| Option | Default |
|---|---|
| `tokenKey` | `"plumbus_auth_token"` |
| `loginEndpoint` | `"/api/auth/login"` |
| `logoutEndpoint` | `"/api/auth/logout"` |
| `refreshEndpoint` | `"/api/auth/refresh"` |
| `multiTenant` | `false` |

## Generated sections

### `generateAuthTypes()`

Generates TypeScript interfaces:

| Type | Purpose |
|---|---|
| `AuthUser` | Current user identity: `userId`, `roles`, `scopes`, optional `tenantId`, provider, and optional session ID. |
| `AuthState` | Current auth state: `user`, `isAuthenticated`, `isLoading`, and `error`. |
| `AuthActions` | Hook action methods: `login`, `logout`, `refreshSession`, and `getToken`. |
| `LoginCredentials` | Flexible login payload: email/password, token, and provider. |
| `AuthConfig` | Endpoint and token-key configuration. |

### `generateTokenUtils(config?)`

Generates browser token helpers:

| Function | Purpose |
|---|---|
| `getStoredToken()` | Reads the token from `localStorage`; returns `null` on the server. |
| `setStoredToken(token)` | Writes the token to `localStorage`; no-ops on the server. |
| `clearStoredToken()` | Removes the token from `localStorage`; no-ops on the server. |
| `parseJwtPayload(token)` | Parses a JWT payload using base64url decoding. |
| `isTokenExpired(token)` | Checks the JWT `exp` claim against the current time. |

The generated utilities guard browser access with `typeof window === "undefined"`.

### `generateAuthFunctions(config?)`

Generates HTTP-based auth functions:

| Function | Behavior |
|---|---|
| `login(credentials)` | POSTs to the login endpoint, stores the returned token, and returns the returned user. |
| `logout()` | POSTs to the logout endpoint and clears the stored token. |
| `refreshSession()` | POSTs to the refresh endpoint, updates the stored token, and returns `AuthUser | null`. |
| `getAuthHeaders()` | Returns `{ Authorization: "Bearer ..." }` when a token exists, otherwise `{}`. |

### `generateUseAuthHook()`

Generates `useAuth()`, which:

- initializes auth state;
- reads and validates the stored token on mount;
- calls `refreshSession()` when a non-expired token exists;
- exposes `login`, `logout`, `refreshSession`, and `getToken` actions.

### `generateUseCurrentUserHook()`

Generates a small `useCurrentUser()` wrapper around `useAuth()`.

### `generateRouteGuard()`

Generates a client-side `RouteGuard` component.

The route guard can check whether the current user has required roles or scopes and can render fallback content or redirect using `window.location.href`.

This is a UX helper only. It must not be treated as an authorization boundary.

### `generateTenantContext()`

Generates `useTenant()` when `multiTenant: true` is used in `generateAuthModule()`.

The tenant helper initializes from `user.tenantId` and lets the frontend maintain a selected tenant ID.

### `generateAuthModule(config?)`

Generates a complete auth helper module.

```ts
const source = generateAuthModule({
  provider: "jwt",
  multiTenant: true,
});
```

The generated module includes:

- React imports;
- the auto-generated file header;
- auth types;
- token utilities;
- HTTP auth functions;
- `useAuth()`;
- `useCurrentUser()`;
- `RouteGuard`;
- tenant helper code when `multiTenant: true`.

## Security notes

The generated auth module stores bearer tokens in `localStorage`. This is convenient for local apps and scaffolding, but it has tradeoffs:

- tokens are readable by JavaScript in the page;
- tokens are not readable by Next.js proxy/middleware;
- client-side route guards can be bypassed by direct API calls;
- backend authorization must be enforced in Plumbus capabilities and policies.

For production applications that require stronger session handling, replace or adapt token storage with an HttpOnly cookie or another server-readable session mechanism and validate it server-side.

## Generation guidance

- Avoid presenting generated auth as a complete security model.
- Keep role and scope authority in backend Plumbus policies.
- Use generated route guards for view-level UX only.
- Ensure all protected backend capabilities enforce their own access policies.
