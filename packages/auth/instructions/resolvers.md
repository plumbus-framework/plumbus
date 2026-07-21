# Identity and Authorization Resolvers

App-owned hooks that connect OIDC identities to Plumbus `ctx.auth`.

## resolveIdentity

Called once after successful OIDC callback (ID token validated).

```ts
type ResolveIdentity = (identity: VerifiedExternalIdentity) => Promise<IdentityResolution>;

// VerifiedExternalIdentity: providerId, issuer, subject, idTokenClaims, userInfoClaims?, acr?, amr?
// IdentityResolution: { status: 'admitted', userId } | { status: 'denied' }
```

**Recipe — admit known users only:**

```ts
resolveIdentity: async (identity) => {
  const row = await db.users.findByOidc(identity.issuer, identity.subject);
  if (!row) return { status: "denied" };
  return { status: "admitted", userId: row.id };
},
```

**Denied** → user redirected to `errorPath` — no session created.

## resolveAuthorization

Called on **every authenticated request** (session or bearer path that resolves to a session principal).

```ts
type ResolveAuthorization = (principal: SessionPrincipal) => Promise<AuthorizationResolution>;

// SessionPrincipal: userId, providerId, issuer, subject, sessionRef, authenticatedAt, acr?, amr?
// AuthorizationResolution:
//   { status: 'authorized', roles, scopes, tenantId? }
//   { status: 'revoked' }
```

**Recipe — load roles from database:**

```ts
resolveAuthorization: async (principal) => {
  const access = await accessService.forUser(principal.userId);
  if (access.suspended) return { status: "revoked" };
  return {
    status: "authorized",
    roles: access.roles,
    scopes: access.scopes,
    tenantId: access.tenantId,
  };
},
```

**Revoked** → session deleted, request treated as anonymous.

## Limits

Config `limits.maxRoles` / `limits.maxScopes` truncate excessive arrays — keep resolver output bounded.

## Timeouts

Resolver calls share `timeouts.resolver` (default 5s). Exceeding budget fails authentication gracefully.

## Critical rules

- **Do not trust ID token roles/scopes directly** unless your IdP is the source of truth — prefer app database in `resolveAuthorization`.
- **Do not cache across requests inside the hook** without invalidation — revocation must propagate.
- **`tenantId` is optional** but required for tenant-scoped capabilities when set on entities.

Human docs: [docs/auth/configuration.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/configuration.md).
