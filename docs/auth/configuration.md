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
| `transactions.ttl` | `"10m"` | Login transaction lifetime (also bounds login context — see below) |
| `transactions.maxOutstandingPerBrowser` | `3` | Binding-cookie scoped cap |
| `loginContext.resolve` | — | Hook that attaches trusted app context to a login transaction |
| `loginContext.params` | `[]` | Login-URL query params owned by the app (never forwarded to the IdP) |
| `loginContext.maxBytes` | `1024` | Serialized context size cap (ceiling `4096`) |
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

## Login context

`resolveIdentity` normally sees only the verified external identity, so an unknown subject that followed an invitation link is indistinguishable from any other unknown subject. **`loginContext`** closes that gap: the app attaches a small trusted object when login starts, and receives it back at admission time.

```typescript
loginContext: {
  params: ["invite"],           // query params on /auth/login[/:provider] owned by the app
  maxBytes: 1024,               // optional — serialized size cap, ceiling 4096
  resolve: async ({ providerId, returnTo, params, cookies }) => {
    const invitation = await invitations.findUsable(params.invite);
    return invitation
      ? { type: "invitation", data: { invitationId: invitation.id } }
      : undefined;              // undefined → ordinary login, no context attached
  },
},
```

```typescript
resolveIdentity: async (identity, context) => {
  const existing = await users.findByOidc(identity.issuer, identity.subject);
  if (existing) return { status: "admitted", userId: existing.id };

  const invitationId = context?.applicationContext?.data?.invitationId;
  if (typeof invitationId !== "string") return { status: "denied" };

  const user = await acceptInvitation(invitationId, identity); // must be idempotent
  return user ? { status: "admitted", userId: user.id } : { status: "denied" };
},
```

### How it travels

The resolved object is sealed inside the **existing login transaction** — the same encrypted, browser-bound, single-use record that carries `state`, `nonce`, and the PKCE verifier. It is handed to `resolveIdentity` only after the callback validates and that transaction is consumed.

**Lifetime is `transactions.ttl`** (default `"10m"`, ceiling 6h). Context does not get its own TTL and cannot outlive the login attempt it belongs to: an expired transaction is rejected before `resolveIdentity` runs, and the periodic sweep deletes expired rows. Shorten `transactions.ttl` to tighten the window in which a started login can be completed.

### Declared params

Query parameters listed in `loginContext.params` are removed from the request **before** provider-parameter validation. Two consequences:

- They cannot reach the identity provider — declared params are never appended to the authorization URL.
- They are the only extra params accepted on the login routes. Undeclared params are still validated as provider parameters and rejected with `400 invalid_request` unless a provider integration allows them.

Param names must match `^[a-zA-Z][a-zA-Z0-9_-]{0,63}$`, must not collide with `returnTo` or an OIDC reserved parameter, and are capped at 8 entries.

### Failure behavior

| Situation | Result |
|---|---|
| Hook returns `undefined` | Ordinary login — `resolveIdentity` receives no `applicationContext` |
| Hook throws or exceeds `timeouts.resolver` | `503 login_unavailable` — login fails closed rather than silently continuing without context |
| Context is oversized or not JSON-serializable | `400 invalid_request` before the provider redirect |
| Transaction expired, replayed, wrong browser, or wrong provider | Callback fails as usual; context is never surfaced |

Context is validated and re-serialized before sealing, so only JSON-representable values survive. It never appears in `/auth/session`, the session record, or audit metadata. See [security.md](./security.md#login-context) for the full property list.

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
