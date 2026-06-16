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

- Keep TTL short: handshake-oriented, not session-long.
- Scope claims to the voice name + session id.
- Avoid putting the token in the URL.
- Rotate rather than reusing long-lived browser-visible secrets.

## `web-speech` trust rule

`web-speech` is attractive because it removes vendor keys, but it is still a trust downgrade compared to server STT. Use it when speed and simplicity matter more than transcript authority.

Production rule of thumb:

- prototypes and low-risk browser flows => `web-speech` may be fine
- billing/compliance/authoritative transcripts => use server STT

## Testing expectations

At minimum, test:

- unauthorized session minting => `401`
- denied access => `403`
- catalog routes reject non-admin callers
- session/token payloads do not contain secrets
- websocket rejects bad/expired session tokens

## Related docs

- [client-stt.md](./client-stt.md)
- [testing.md](./testing.md)
- [configuration.md](./configuration.md)
