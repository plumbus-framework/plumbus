# Upgrading to the 0.8.5 security release

This patch release fixes the security findings that affect the 0.8 line: core **0.8.5**, api **0.3.1**, mcp **0.7.1**, chat **0.3.2**, voice **0.6.2**, auth-cognito **0.3.1**, ui **0.9.1**.

Nothing here requires code changes. Fixes that only stop misuse, such as one tenant reaching another tenant's data, are on by default. Fixes that could break a legitimate setup are opt-in. When an app runs the unsafe path, it logs a one-time warning naming the option.

## Upgrade

```
pnpm up @plumbus/core@0.8.5   # plus each add-on you use, to the versions above
pnpm install                  # refreshes transitive packages (proxy-addr, hono, fast-uri, postcss, ...)
```

Plumbus raises its own minimum versions, but your app's lockfile decides which transitive versions you get. Run `pnpm audit --prod` after upgrading. What remains on 0.8 is described under [Not fixed on 0.8](#not-fixed-on-08).

## On by default

| Area | Change | Who notices |
|---|---|---|
| Flows | An event resumes only executions waiting in its own tenant. A tenantless event resumes only tenantless executions. | Apps that relied on one tenant's event waking another tenant's flow. |
| Flows | `ctx.flows.resume` / `cancel` / `status` on another tenant's execution answer "not found". | Same. System callers without a tenant are unchanged. |
| Jobs | `GET /api/jobs/:jobId` keeps every role inside its own tenant. Only `admin`/`system` without a `tenantId` sees across tenants. | Tenant admins who read other tenants' jobs. |
| OIDC | Tokens with `nbf` or `iat` more than 60 s in the future are rejected (`clockSkewSeconds`). | Identity providers with badly skewed clocks. |
| MCP | Stateless HTTP serves each request with its own transport. That fixes the second request failing on SDK 1.32. | Nobody. |
| MCP | Stateful sessions are bound to the user and tenant that opened them, and tasks to their session. | Clients that shared one session id between principals. |
| MCP | `tools/call` arguments are capped at 100 000 elements (`maxToolInputElements`). | Nobody in practice. |
| API | The default in-memory idempotency store keeps records for 24 h and at most 10 000 of them. | Apps that expected a key to be remembered forever in one process. Pass `defaultTtlMs: Infinity` to keep that. |
| Chat | A session id only works with the chat that created it. Pending-action metadata is only shown to the session's owner. Raw internal errors are no longer sent to clients. | Apps that renamed a chat: old sessions start over. |
| Voice | Clone uploads stop at the size limit while streaming. Raw vendor errors are no longer sent to clients. | Nobody. The limit already existed. |
| Fastify 5.12 | A numeric `trustProxy` (hop count) now trusts no proxy. Plumbus warns when it sees one. | Apps that set `trustProxy: <number>`. Use the proxy addresses/CIDRs or `true`. |

## Opt-in in 0.8.5 (planned to become the default in 0.9)

| Option | Package | Turns on | Warning when off |
|---|---|---|---|
| `DATABASE_SSL_ENFORCE=true` / `database.sslEnforce` | core | Passes the configured `ssl` to postgres.js. Before this, `ssl: true`, the production default, was never applied. | When `ssl` is configured: "connection is not using TLS" |
| `enforceExecutionOwnership` / `PLUMBUS_FLOW_ENFORCE_OWNERSHIP=true` | core | Only the starting actor may resume, cancel or read an execution | When another actor in the same tenant does it |
| `requireExp` (`createOidcAdapter`) | core | Rejects OIDC tokens without a numeric `exp` | When such a token arrives |
| `plumbus api validate --fail-on-security` | core CLI | Security findings fail the command (exit 1) | A notice when findings exist |
| `rejectActionsOverGet` (`registerApiRoutes`) | api | Refuses to register `action` capabilities on GET | Names each GET action at registration |
| `requireBrowserSecurity` (`registerChatRoutes`) | chat | Startup error when cookie auth lacks `csrfSecret` + `externalBaseUrl` | At registration |
| `csrfSecret` + `externalBaseUrl` (voice routes) | voice | Origin + CSRF checks on cookie-authenticated writes; `wsUrl` built from `externalBaseUrl` | When cookie auth or header-derived `wsUrl` is used |
| `rejectQuerySessionToken`, `singleUseSessionTokens` | voice | WebSocket token only in `Sec-WebSocket-Protocol`; each token used once (per process) | An empty `websocketOriginAllowlist` warns |
| `reconcileClient` (`ensureAttestedUserPool`) | auth-cognito | Rewrites a same-named app client that has weaker settings | Lists the drift and returns `clientDrift` |
| `sessionIdleTimeoutMs` | mcp | Closes idle stateful sessions | None |

Recommended for production now: `DATABASE_SSL_ENFORCE=true` if your database accepts TLS, `rejectActionsOverGet: true`, `requireBrowserSecurity: true`, and the voice `csrfSecret` + `externalBaseUrl`. If you use LiveKit, see the caveat in [voice security](voice/security.md#hardening-options-voice-062) first.

## Not fixed on 0.8

- **zod 3** (GHSA-mrhx-c7xc-m3w5, memory exhaustion on oversized constrained collections). The fix exists only in zod 4, and core re-exports zod as `@plumbus/core/zod`, so this needs Plumbus 0.9. Plumbus's own audit gate ignores this one advisory, with that reason recorded in `pnpm-workspace.yaml`.
- **Moderate transitive advisories with no in-range fix:** `@hono/node-server` (inside the MCP SDK, `serveStatic` only, which Plumbus does not use), `glob` / `minimatch` (inside LiveKit's agent tooling), and `esbuild` (dev servers used by `tsx` and `drizzle-kit`).
- **Generated UI bearer transport** still defaults to `localStorage`. Use `--auth-transport session` for browser apps.
