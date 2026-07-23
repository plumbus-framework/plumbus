# Migrating to `@plumbus/auth`

**Previous:** [testing.md](./testing.md) · **Next:** [deployment.md](./deployment.md)

Guide for apps moving from **`auth.provider: jwt`** in Plumbus config, custom `authAdapter` implementations, or `@plumbus/ui` localStorage bearer scaffolding to federated OIDC with server sessions.

---

## Decision checklist

Migrate when you need:

- Browser login redirect to an enterprise IdP or Cognito hosted UI
- HttpOnly session cookies instead of JavaScript-readable bearer tokens
- CSRF-protected mutating requests from a same-site or cross-origin SPA
- Central session revocation via `resolveAuthorization` → `revoked`

Stay on **`createJwtAdapter()`** or **`createOidcAdapter()`** when:

- All callers are machine clients presenting bearer tokens
- There is no browser login surface
- You do not need server-side session inventory

Both models can coexist: pass **`bearer: createOidcAdapter(...)`** to `createAuthRuntime()`.

---

## From Plumbus JWT config

**Before:**

```typescript
// config
auth: { provider: "jwt", secret: process.env.AUTH_SECRET }
```

**After:**

1. Remove reliance on `auth.secret` for browser users.
2. Install `@plumbus/auth` and wire `createServer({ authenticationRuntime })`.
3. Set `auth.provider: 'custom'` in config (or supply only `authenticationRuntime` — core 0.6.8+ skips secret requirement).
4. Implement `resolveIdentity` / `resolveAuthorization` against your user directory.

Existing **`signJwt()`** flows for service accounts can remain as the optional bearer adapter.

---

## From `@plumbus/ui` generated auth helpers

Generated `lib/auth.ts` stores tokens in **localStorage** and sends `Authorization: Bearer`. For `@plumbus/auth`:

1. Replace login/logout calls with redirects to `/auth/login` and `POST /auth/logout`.
2. Load user state from `GET /auth/session`.
3. Send **`credentials: 'include'`** and **`X-CSRF-Token`** on API mutations.
4. Remove localStorage token keys from production code paths.

Regenerate UI clients after changing fetch wrappers — do not edit generated contract files by hand.

See [docs/ui/ui-generation.md](../ui/ui-generation.md).

---

## From custom `authAdapter`

If you already implement `AuthAdapter`:

1. Map your session lookup into **`SessionStore`** or adopt PostgreSQL stores.
2. Move login redirect logic into OIDC provider config — delete bespoke `/login` routes that duplicate `/auth/login`.
3. Pass your bearer validator as `createAuthRuntime(config, { bearer: existingAdapter })` during transition.

Delete the custom adapter once all clients use cookie sessions.

---

## Database migration

Apply `@plumbus/auth` SQL migration (`auth_sessions`, `auth_login_transactions`) before switching production traffic. Run dual-write or hard-cutover only after stores are verified.

---

## Agent wiring

After upgrade, refresh agent instructions:

```bash
plumbus doctor          # recommends plumbus init --patch when wiring version < 9
plumbus init --patch
```

`AGENT_WIRING_VERSION` **9** references `@plumbus/auth` and `@plumbus/auth-cognito` instruction files.

- **Bare `plumbus init` does not update** existing agent files — it skips them and prints a hint to use `--patch` or `--force`.
- **`plumbus init --patch`** replaces only the managed block between `plumbus:agent-wiring` markers; user content outside those markers is preserved.
- **Targets:** `.github/copilot-instructions.md`, `.cursor/rules/`, and `AGENTS.md` — not `CLAUDE.md` (copy references manually if needed).

---

## Rollback

Keep bearer adapter configured until all SPAs send cookies. To roll back, remove `authenticationRuntime` and restore `auth.provider: 'jwt'` with `auth.secret`.
