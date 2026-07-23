# Auth Runtime Configuration

**Previous:** [getting-started.md](./getting-started.md) · **Next:** [providers.md](./providers.md)

Reference for `AuthRuntimeConfig` passed to `createAuthRuntime()`. Validation runs through `validateAuthRuntimeConfig()` at runtime construction.

---

## Required fields

| Field | Type | Description |
|---|---|---|
| `applicationId` | `string` | Logical app id — scopes session and transaction rows in shared databases |
| `environment` | `'development' \| 'production'` | Influences cookie `Secure` flag and same-site assertions |
| `externalBaseUrl` | `string` | Public URL of the auth routes (where browsers hit `/auth/*`) |
| `applicationBaseUrl` | `string` | SPA or server-rendered app origin (for `returnTo` validation) |
| `defaultReturnPath` | `string` | Relative path after login when `returnTo` is omitted (must start with `/`) |
| `errorPath` | `string` | Relative path for login error redirects |
| `session.ttl` | duration string | Session lifetime (e.g. `"7d"`, `"12h"`) — parsed by core duration helper |
| `sessionStore` | `SessionStore` | Opaque session persistence |
| `transactionStore` | `LoginTransactionStore` | Short-lived login state |
| `storageProtection` | `StorageProtectionConfig` | HMAC + envelope encryption for stored payloads |
| `providers` | `Record<string, OidcProviderRegistration>` | At least one OIDC provider |
| `resolveIdentity` | `ResolveIdentity` | Admit or deny external identities |
| `resolveAuthorization` | `ResolveAuthorization` | Map session principal → roles/scopes/tenant |

---

## Optional fields

| Field | Default | Description |
|---|---|---|
| `basePath` | `'/auth'` | Route prefix for all auth endpoints |
| `defaultProvider` | — | Provider id for `GET /auth/login` |
| `session.cookieName` | `__Host-plumbus_session` | Session cookie name (`__Host-` prefix enforces secure, path=/, no Domain) |
| `session.sameSite` | `'Lax'` | Session cookie `SameSite` attribute (`'Lax'` or `'Strict'`). Login binding cookies always use `Lax`. |
| `session.maxSessionsPerUser` | `5` | Oldest sessions evicted when cap exceeded |
| `transactions.ttl` | `"10m"` | Login transaction lifetime |
| `transactions.maxOutstandingPerBrowser` | `3` | Binding-cookie scoped cap |
| `timeouts.resolver` | `"5s"` | `resolveIdentity` / `resolveAuthorization` budget |
| `timeouts.providerFetch` | `"10s"` | OIDC discovery and token endpoint fetch budget |
| `limits.maxRoles` | `32` | Truncation guard on authorization output |
| `limits.maxScopes` | `64` | Truncation guard on authorization output |
| `deployment.assumeSameSite` | `false` | Skip same-site URL assertion (local dev only) |
| `auditWriter` | — | Plumbus `AuditWriter` for auth lifecycle events |

Pass `auditWriter` or inject via `createAuthRuntime(config, { auditWriter })`.

---

## URL semantics

```
externalBaseUrl   → where /auth/login and /auth/callback are registered
applicationBaseUrl → where returnTo paths resolve (your SPA)
```

For a typical split deployment:

- API + auth routes: `https://api.example.com`
- Frontend: `https://app.example.com`

Set `externalBaseUrl` to the API origin and `applicationBaseUrl` to the SPA origin. `returnTo` must be a **relative path** on the application origin (e.g. `/dashboard`), never an absolute off-site URL.

`assertSameSiteDeployment()` compares registrable domains unless `deployment.assumeSameSite: true`.

---

## Storage protection

Production deployments must configure a **32-byte** root key. Add prior keys under `decryptOnlyKeys` during rotation:

```typescript
storageProtection: {
  activeKey: {
    id: "k2",
    value: process.env.AUTH_STORAGE_KEY!, // 32-byte secret (64 hex chars)
  },
  decryptOnlyKeys: [
    { id: "k1", value: process.env.AUTH_STORAGE_KEY_PREVIOUS! },
  ],
},
```

Development may omit `storageProtection` entirely — the runtime generates an ephemeral dev key. For deterministic local tests, pass a fixed `activeKey` as above.

---

## Bearer coexistence

```typescript
createAuthRuntime(config, {
  bearer: createOidcAdapter({ issuer, audience }), // optional
});
```

Composite authentication checks **bearer first**, then session cookie. Use bearer for service accounts and session cookies for browser users.

---

## Health

`authenticationRuntime.describeHealth?.()` returns `{ status: 'ok' | 'degraded', providers: { [id]: 'available' | 'unavailable' } }` based on OIDC discovery probes during `initialize()`.

Wire into your ops dashboard alongside database and queue health.
