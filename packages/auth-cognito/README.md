# @plumbus/auth-cognito

Amazon Cognito provider integration for [`@plumbus/auth`](../auth/). Supplies the **`cognito()`** integration object: hosted UI `identity_provider` allowlist and logout URL construction (`client_id` + `logout_uri`).

**Confidential client only** — Cognito app clients must have a client secret; public/SPA clients are not supported by `@plumbus/auth`.

Peer: `@plumbus/auth` at **`0.1.x`**.

## Install

```bash
pnpm add @plumbus/auth @plumbus/auth-cognito
```

## Usage

```typescript
import { createAuthRuntime } from "@plumbus/auth";
import { cognito } from "@plumbus/auth-cognito";

const authenticationRuntime = createAuthRuntime({
  // …applicationId, URLs, stores, resolvers
  providers: {
    cognito: {
      type: "oidc",
      issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX",
      clientId: process.env.COGNITO_CLIENT_ID!,
      clientSecret: { env: "COGNITO_CLIENT_SECRET" },
      scopes: ["openid", "email"],
      integration: cognito({
        hostedLogin: { allowedIdentityProviders: ["Google", "COGNITO"] },
        logout: { domain: "https://myapp.auth.us-east-1.amazoncognito.com" },
      }),
      providerLogout: { returnTo: "/" },
    },
  },
  defaultProvider: "cognito",
});
```

## Documentation

- **Human docs:** [`docs/auth/cognito.md`](../../docs/auth/cognito.md)
- **Agent instructions:** [`instructions/`](./instructions/)

## The Plumbus ecosystem

| Package | Purpose | When to install |
|---|---|---|
| [`@plumbus/core`](../plumbus-core/) | Foundation — capabilities, entities, events, flows, prompts, translations, runtime, CLI, audit, governance. | Always (required). |
| [`@plumbus/ui`](../ui/) | Next.js/React UI — typed API clients, auth helpers, form metadata, scaffolds. | When building a Plumbus web UI. |
| [`@plumbus/auth`](../auth/) | OIDC RP runtime — hosted login, opaque server sessions, CSRF, protected stores. | Peer `0.6.x` on core — when adding federated browser login. |
| **`@plumbus/auth-cognito`** | **You are here.** Cognito hosted UI options, client auth method, logout URL builder. | With `@plumbus/auth` `0.1.x` — when the IdP is Amazon Cognito. |
| [`@plumbus/api`](../api/) | Partner external API — manifest, OpenAPI, docs, compatibility diff, test intent. | Optional peer `0.1.x` — when publishing a documented partner-facing HTTP API. |
| [`@plumbus/mcp`](../mcp/) | MCP runtime — serve capabilities to AI agents (`tools/*`, `tasks/*`, transports). | Optional peer `0.5.x \|\| 0.6.x` — when exposing capabilities to MCP clients. |
| [`@plumbus/chat`](../chat/) | Conversational runtime — `defineChat`, policy guards, context sources, streamed events. | Optional peer `0.1.x` — when adding a chat surface. |
| [`@plumbus/chat-ui`](../chat-ui/) | React chat UI — hooks and `<ChatPanel />` for the `@plumbus/chat` turn protocol. | Peer of `@plumbus/chat` — when adding a browser chat client. |
| [`@plumbus/knowledge-base`](../knowledge-base/) | Knowledge providers — scoped sources, registry, chat `knowledgeContext` integration. | Optional peer of `@plumbus/chat` `0.1.x` — when sharing named knowledge across features. |
| [`@plumbus/voice`](../voice/) | Real-time voice runtime — `defineVoice`, STT/TTS/transport providers, session worker, cost ledger. | Optional peer `0.3.x` on `@plumbus/core` `0.6.x` — when adding speech I/O (not speech-to-speech); complements `@plumbus/chat` text surfaces. |
| [`@plumbus/browser-extension`](../browser-extension/) | Extension scaffolder — WXT Chrome/Firefox project wired to your capabilities. | With `@plumbus/ui` (`0.1.x`) — when shipping a browser extension UI. |

## Links

- **Auth docs** — [docs/auth/](../../docs/auth/)
- **Issues** — [github.com/plumbus-framework/plumbus/issues](https://github.com/plumbus-framework/plumbus/issues)
