# Identity and Authorization Resolvers

App-owned hooks that connect OIDC identities to Plumbus `ctx.auth`.

## resolveIdentity

Called once after successful OIDC callback (ID token validated).

```ts
type ResolveIdentity = (
  identity: VerifiedExternalIdentity,
  context?: IdentityResolutionContext,
) => Promise<IdentityResolution>;

// VerifiedExternalIdentity: providerId, issuer, subject, idTokenClaims, userInfoClaims?, acr?, amr?
// IdentityResolution: { status: 'admitted', userId } | { status: 'denied' }
// IdentityResolutionContext: { applicationContext?: { type: string, data?: Record<string, unknown> } }
```

The second argument is optional — ignore it unless the app configures `loginContext`.

**Recipe — admit known users only:**

```ts
resolveIdentity: async (identity) => {
  const row = await db.users.findByOidc(identity.issuer, identity.subject);
  if (!row) return { status: "denied" };
  return { status: "admitted", userId: row.id };
},
```

**Denied** → user redirected to `errorPath` — no session created.

## Invitation-only admission (`loginContext`)

Use when new users may only be created by following an invitation. Two halves — attach context at login start, consume it at admission.

**1. Declare the param and resolve the context** (in `createAuthRuntime` config):

```ts
loginContext: {
  params: ["invite"],          // stripped from provider params — never sent to the IdP
  resolve: async ({ params }) => {
    const invitation = await db.invitations.findUsable(params.invite);
    return invitation
      ? { type: "invitation", data: { invitationId: invitation.id } }
      : undefined;             // undefined → ordinary login
  },
},
```

**2. Gate admission on it:**

```ts
resolveIdentity: async (identity, context) => {
  const existing = await db.users.findByOidc(identity.issuer, identity.subject);
  if (existing) return { status: "admitted", userId: existing.id };

  const invitationId = context?.applicationContext?.data?.invitationId;
  if (typeof invitationId !== "string") return { status: "denied" };

  const user = await acceptInvitationIdempotent(invitationId, identity);
  return user ? { status: "admitted", userId: user.id } : { status: "denied" };
},
```

Invite links point at `/auth/login/<provider>?invite=<token>&returnTo=/welcome`.

### Rules

- **Resolve the token server-side, store a reference.** Look the invitation up in the hook and seal its id — never seal the raw token or unvalidated query input.
- **Make admission side effects idempotent.** The transaction is already consumed when `resolveIdentity` runs; a throw or `timeouts.resolver` overrun maps to a temporary failure, so a retry must not meet a spent invitation. Key on `(issuer, subject)`.
- **Still check the identity.** Context proves the login carried a valid invitation, not that the right person completed it. Match the invited email against `idTokenClaims` and require `email_verified`, or accept bearer-link semantics deliberately.
- **Keep it small.** Serialized context is capped (`loginContext.maxBytes`, default 1024, ceiling 4096) and must be JSON-serializable.
- **Do not use it for anything the session needs later.** Context is single-use, expires with `transactions.ttl` (default `10m`), and is never persisted to the session — copy what you need into app state during `resolveIdentity`.
- **Do not add ad-hoc query params to login URLs.** Undeclared params are rejected as provider params (`400 invalid_request`) or forwarded to the IdP.

A hook that throws fails the login with `503 login_unavailable` — deliberate, so an outage cannot silently downgrade an invitation login to an ordinary one.

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

Resolver calls share `timeouts.resolver` (default 5s) — including `loginContext.resolve`. Exceeding budget fails authentication gracefully.

## Critical rules

- **Do not trust ID token roles/scopes directly** unless your IdP is the source of truth — prefer app database in `resolveAuthorization`.
- **Do not cache across requests inside the hook** without invalidation — revocation must propagate.
- **`tenantId` is optional** but required for tenant-scoped capabilities when set on entities.

Human docs: [docs/auth/configuration.md](https://github.com/plumbus-framework/plumbus/blob/main/docs/auth/configuration.md).
