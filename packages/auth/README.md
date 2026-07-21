# @plumbus/auth

OIDC relying-party runtime for Plumbus applications: hosted login redirect, authorization code + PKCE callback, opaque **`__Host-plumbus_session`** cookies, CSRF for mutating requests, and protected session/transaction stores (memory or PostgreSQL).

Peer: `@plumbus/core` at **`0.6.x`**.

## Install

```bash
pnpm add @plumbus/auth
```

Optional Cognito helpers: `pnpm add @plumbus/auth-cognito`

## Quick start

```typescript
import {
  createAuthRuntime,
  createMemorySessionStore,
  createMemoryLoginTransactionStore,
} from "@plumbus/auth";
import { createServer } from "@plumbus/core";

const authenticationRuntime = createAuthRuntime({
  applicationId: "my-app",
  environment: "development",
  externalBaseUrl: "http://localhost:3000",
  applicationBaseUrl: "http://localhost:3001",
  defaultReturnPath: "/",
  errorPath: "/login/error",
  session: { ttl: "7d" },
  sessionStore: createMemorySessionStore(),
  transactionStore: createMemoryLoginTransactionStore(),
  storageProtection: {
    activeKey: {
      id: "k1",
      value: process.env.AUTH_STORAGE_KEY!, // 32-byte secret (64 hex chars)
    },
  },
  providers: {
    okta: {
      type: "oidc",
      issuer: "https://example.okta.com/oauth2/default",
      clientId: process.env.OKTA_CLIENT_ID!,
      clientSecret: { env: "OKTA_CLIENT_SECRET" },
      scopes: ["openid", "profile", "email"],
    },
  },
  defaultProvider: "okta",
  resolveIdentity: async (identity) => ({
    status: "admitted",
    userId: await mapSubjectToUserId(identity.subject),
  }),
  resolveAuthorization: async (principal) => ({
    status: "authorized",
    roles: await loadRoles(principal.userId),
    scopes: [],
  }),
});

await createServer({ authenticationRuntime /* … */ });
```

## Routes

Default prefix **`/auth`**: `providers`, `login`, `login/:provider`, `callback/:provider`, `session`, `logout`.

Browsers probe **`GET /auth/session`** and send **`X-CSRF-Token`** on mutations.

## Exports

| Subpath | Purpose |
|---|---|
| `@plumbus/auth` | `createAuthRuntime`, memory stores, diagnostics, types |
| `@plumbus/auth/postgres` | PostgreSQL session + transaction stores |
| `@plumbus/auth/testing` | `startFakeOidcProvider()` for integration tests |

## Documentation

- **Human docs:** [`docs/auth/`](../../docs/auth/) in the monorepo
- **Agent instructions:** [`instructions/`](./instructions/) (shipped in npm tarball)

## Migrations

SQL: [`migrations/0001_auth_init.sql`](./migrations/0001_auth_init.sql) — `auth_sessions`, `auth_login_transactions`.

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| **`@plumbus/auth`** | **You are here.** OIDC RP runtime — hosted login, opaque server sessions, CSRF, protected stores. | Peer `0.6.x` on core — when adding federated browser login with server sessions. |
| [`@plumbus/auth-cognito`](../auth-cognito/) | Cognito integration — hosted UI IdP allowlist, client auth method, logout URL builder. | With `@plumbus/auth` `0.1.x` — when using Amazon Cognito. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x \|\| 0.6.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/voice`](../voice/) | Real-time voice runtime — `defineVoice`, STT/TTS/transport providers, session worker, cost ledger. | Optional peer `0.3.x` on `@plumbus/core` `0.6.x` — when adding speech I/O (not speech-to-speech); complements `@plumbus/chat` text surfaces. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## Links

- **Full documentation** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
