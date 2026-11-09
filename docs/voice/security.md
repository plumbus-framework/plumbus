# Voice Security

Real-time voice adds attack surface that text chat does not: websocket upgrades, session tokens, browser-originated transcripts, and transport-provider secrets. This document captures the v1 threat model for `@plumbus/voice`.

## Threat model (S1-S10)

| ID | Risk | Requirement |
|---|---|---|
| S1 | WebSocket upgrade auth + origin | Validate `Origin` against an app-supplied allowlist and authenticate before accepting the realtime session. Prefer session tokens in `Sec-WebSocket-Protocol`, not query strings. |
| S2 | Cookie-auth CSRF | Prefer explicit Bearer/session-token auth for the voice handshake. If cookies are used, require `SameSite` policy plus origin checks. |
| S3 | Client transcript trust (`web-speech`) | Treat browser transcript text as untrusted `client-stt` input. Apply content/length guards and never treat it as authoritative or billable STT evidence. |
| S4 | Session token replay / expiry | Mint short-lived scoped tokens (handshake-oriented TTL). Include `voiceName`, `sessionId`, transport, and other bounded claims. |
| S5 | LiveKit JWT scoping | Sign LiveKit grants with LiveKit credentials only. Scope grants to the specific room + participant identity. |
| S6 | Per-session cost / DoS caps | Apply voice session caps for duration, concurrency, and media usage in addition to generic AI budgets. |
| S7 | Secrets leaking to browser | Session and token routes return only short-lived tokens and public URLs. They must never include `apiKey`, `apiSecret`, `voicePromptId`, or raw provider payloads. |
| S8 | PII in transcripts / logs | Do not log raw transcript text or raw audio. Treat transcripts as highly sensitive and document retention decisions explicitly. |
| S9 | Catalog topology exposure | Guard `/api/voice/catalog*` behind admin access. These routes expose provider/model/topology information. |
| S10 | Budget bypass in ephemeral mode | If a deployment uses ephemeral or client-derived state, document that client-derived caps are advisory. Durable enforcement requires server session state. |

## Framework-owned protections

`@plumbus/voice` owns:

- session-token minting and verification helpers
- websocket origin-policy hook-up
- deny-by-default access evaluation on session/token/health routes
- admin guard on catalog routes
- secret-stripping expectations for session payloads
- transcript trust tagging (`client-stt` vs `server-stt`)

## App-owned responsibilities

The package does **not** replace normal app security work. The app still must:

1. register CORS with an explicit origin policy
2. decide Bearer vs cookie auth for the handshake
3. set cookie `SameSite` policy if cookies are used
4. configure `trustProxy` correctly behind proxies/load balancers
5. choose retention policy for transcripts or audio
6. enforce any durable rate limits at the deployment edge or app layer

## Session token guidance

The `plumbus voice` CLI shares its base runtime bootstrap with `plumbus mcp serve`. It resolves `PLUMBUS_ENV`, then `NODE_ENV`, defaulting to `development`; outside development it requires configured authentication before opening database or queue connections. For CLI JWT authentication, set an explicit `AUTH_SECRET` of at least 32 characters excluding surrounding whitespace. Known development placeholders are rejected in every environment. These credentials are separate from voice session-token and provider secrets. See [CLI authentication](../mcp/agent-authentication.md#cli-environment-and-credentials).

- Keep TTL short: handshake-oriented, not session-long.
- Scope claims to the voice name + session id.
- Avoid putting the token in the URL.
- Rotate rather than reusing long-lived browser-visible secrets.

## `web-speech` trust rule

`web-speech` is attractive because it removes vendor keys, but it is still a trust downgrade compared to server STT. Use it when speed and simplicity matter more than transcript authority.

Production rule of thumb:

- prototypes and low-risk browser flows => `web-speech` may be fine
- billing/compliance/authoritative transcripts => use server STT

## Voice cloning

`registerVoiceCloneRoutes` adds ownership-aware clone HTTP. See [voice-cloning.md](./voice-cloning.md).

- Reference audio is PII — never log raw samples.
- Every per-id route must pass `resolveCloneOwner` (framework compares to `auth.userId`).
- `GET /clones` uses app `listOwnedClones` only — never dump the shared API-key vendor bank.
- Create → `afterCloneCreate` failure triggers best-effort vendor `delete` (no orphan unowned voices).
- `POST .../synthesize-reference` is a spoofing surface — require `referenceAccess` (stricter than self-clone), consent, and rate limits.
- Shared vendor API keys share one voice bank; true tenant isolation needs per-tenant vendor projects/keys.
- Upload size is capped by `min(opts.maxSampleBytes, capabilities.maxSampleBytes)`.
- S7 still applies: session/token payloads must never include vendor secrets or raw clone samples.

## Hardening options (voice 0.6.2)

All of these are opt-in; leaving them unset keeps the 0.6.1 behaviour and logs a one-time warning where noted.

| Option | On | Default | Effect |
|---|---|---|---|
| `externalBaseUrl` | `registerVoiceRoutes`, `registerVoiceCloneRoutes` | unset | Public app URL (`https://app.example.com`). With `csrfSecret`, enables browser checks below. On `registerVoiceRoutes` it also builds `/session`'s `wsUrl` from this URL (`http`→`ws`, `https`→`wss`) instead of `Host` / `X-Forwarded-Proto`. Must be an absolute http(s) URL (checked at registration). Without it, `wsUrl` is still header-derived and a one-time warning is logged. |
| `csrfSecret` | both | unset | With `externalBaseUrl`, cookie-authenticated writes (`POST /session`, `POST /token`, every non-GET clone route) need an exact `Origin` match and, once the browser holds the `plumbus_voice_csrf` cookie, the same value echoed in the `x-plumbus-voice-csrf` header (same model as `@plumbus/chat`). The first write before the cookie exists passes on the Origin match. Authorization-header requests and GET routes are unaffected. Cookie auth without both options logs a one-time warning. Names are exported as `VOICE_CSRF_COOKIE_NAME` / `VOICE_CSRF_HEADER_NAME` (also from `@plumbus/voice/client`). |
| `rejectQuerySessionToken` | `registerVoiceRoutes` | `false` | Websocket handshakes must send the token as `Sec-WebSocket-Protocol: voice-session.<token>`; `?sessionToken=` is rejected. |
| `singleUseSessionTokens` | `registerVoiceRoutes` | `false` | Each handshake token (its `jti`) is accepted once until it expires. The record is a bounded in-process store (10,000 ids; expired ids pruned first, then oldest evicted), so with several API replicas a token can be redeemed once per replica. Tokens minted by voice < 0.6.2 have no `jti` and are rejected while this is on. |

An empty `websocketOriginAllowlist` still accepts every (or no) `Origin`, and now logs a one-time warning.

**LiveKit browser clients and `csrfSecret`:** `createLiveKitVoiceSession` (`@plumbus/voice-livekit/client`, 0.3.x) does not echo the `x-plumbus-voice-csrf` header. If you turn on `csrfSecret` and the browser authenticates `/token` with a cookie, the first call passes on the Origin match and later calls get `403 voice.origin_invalid`. Authenticate those calls with `authHeader` (Authorization header, which the CSRF check does not apply to), or leave `csrfSecret` off for LiveKit-only apps until voice-livekit sends the header.

Always-on in 0.6.2:

- Clone uploads (`POST .../clones`, `POST .../synthesize-reference`) are counted while streaming and stop as soon as `min(opts.maxSampleBytes, capabilities.maxSampleBytes)` is exceeded, returning the same `400 voice.clone.sample_too_large`. The limit (+1 byte) is also passed to `request.file()` / `request.parts()` as `limits.fileSize`. `synthesize-reference` rejects an unknown or non-reference provider before reading the upload.
- Clients get generic messages for clone vendor failures (`error` code kept, no vendor text or `metadata`), `afterCloneCreate` failures, and voice-turn runtime failures (`voice.runtime_error`, message `Voice turn failed`). Details are logged server-side with `console.error`.

## Testing expectations

At minimum, test:

- unauthorized session minting => `401`
- denied access => `403`
- catalog routes reject non-admin callers
- session/token payloads do not contain secrets
- websocket rejects bad/expired session tokens
- clone routes: 401/403 access, 403 ownership, create-persist rollback delete, listOwnedClones-only list

## Related docs

- [client-stt.md](./client-stt.md)
- [testing.md](./testing.md)
- [configuration.md](./configuration.md)
- [voice-cloning.md](./voice-cloning.md)

WebSocket input is capped before conversion or resampling: 64 KiB per audio message, 16 KiB per control message, and 256 KiB pending input per connection. Oversized input closes with 1009. Input callbacks are serialized and each audio frame is delivered once. The WebSocket plugin also has a 64 KiB `maxPayload`. An omitted/empty session budget emits a startup warning: duration/media caps are optional, not silently assumed. Configured budgets and usage must be finite and nonnegative. Explicit session-token secrets require at least 32 non-padding characters.

Default LiveKit room names include the authenticated tenant when present. Explicit room names and app-owned room resolvers remain application-authorized sharing mechanisms; a resolver now receives `tenantId` as well as user/session identity. Redis event envelopes are schema-validated before delivery, and malformed envelopes are discarded with a diagnostic rather than repeatedly requeued.

Voice handshake JWT lifetimes must be finite positive whole seconds (default 90, with existing configured lifetimes preserved); established session duration remains a separate session-budget/lifecycle setting.

### Configurable transcript bounds

`transcript.maxChars` defaults to 4,000 and is validated by `defineVoice`. It changes the per-turn text bound only; client/server trust tags, cost/budget checks and inbound audio/control limits remain enforced. LiveKit's large-event text-stream path is outbound from the agent; it does not increase the client's control-message limit or grant client speech authoritative status. The browser bounds stream size/time and aborts readers on disconnect. See [configuration](./configuration.md).

## Uploaded files

File transcription is a server-only extension used inside authorized Plumbus capabilities and flows. The app owns inspected input, current processing rights, tenant scope, durable budget reservations, result adoption and cleanup. Never treat a client reference as provider idempotency. Unknown external outcomes require reconciliation before any new paid request. See [file transcription](file-transcription.md) for bounded streams, explicit regions, sanitized errors, unknown bills and deletion semantics.
