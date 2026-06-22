# Voice Security — Agent Rules

Read this before exposing any voice routes.

## Non-negotiable rules

- **S1:** Always validate websocket `Origin` against an app-owned allowlist.
- **S2:** Prefer explicit Bearer/session-token auth for the websocket handshake over ambient cookies.
- **S3:** Treat `web-speech` transcript text as untrusted `client-stt` input. Never bill it as authoritative STT usage.
- **S4:** Mint short-lived scoped session tokens. Include `voiceName`, `sessionId`, and transport claims.
- **S5:** LiveKit tokens must use LiveKit credentials, not the app auth secret.
- **S6:** Apply session duration / concurrency / media caps through the voice budget path, not just per-call AI limits.
- **S7:** Never return `apiKey`, `apiSecret`, `voicePromptId`, or provider responses to the browser.
- **S8:** Never log raw transcripts or raw audio payloads.
- **S9:** Guard catalog routes behind admin access.
- **S10:** If a voice session is ephemeral/client-derived, document that any caps derived from the client are advisory.

## Do's

- **Do** send the websocket session token in `Sec-WebSocket-Protocol` where possible.
- **Do** keep token TTLs short (handshake-oriented, not long-lived session cookies).
- **Do** document app-owned CORS, `SameSite`, and `trustProxy` responsibilities.
- **Do** add tests asserting that session and token responses do not contain secrets.

## Don'ts

- **Don't** put voice tokens in URLs unless there is no alternative.
- **Don't** reuse `AUTH_SECRET` for LiveKit signing.
- **Don't** expose `GET /api/voice/catalog*` anonymously.
- **Don't** rely on browser transcript text for billing, compliance evidence, or security-sensitive truth.

## Deeper reference

- `/docs/voice/security.md`
