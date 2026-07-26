# Changelog

## 0.1.7 — 2026-07-24 — confirm round-trip + tool-calling events

### Changed

- **`useChat.confirm()` performs the real confirmation round-trip.** It now POSTs to `confirmUrl` (default `/chat/{chatName}/confirm`) instead of only clearing local state. Added `decline(actionId)` and `lastConfirmResult` (a `ChatUiConfirmResult`). Cookie-authenticated apps must be served from the server's configured origin (exact-Origin + CSRF enforced server-side).
- **`applyChatEvent` reducer** handles the new `tool.started` / `tool.completed` / `tool.failed` / `confirmation.resolved` events and the additive `inputSchemaHash` / `projection` fields on `confirmation_required`.
- **`<ConfirmationDialog />` is wired through `<ChatPanel />`** to `confirm` / `decline`.

### Requires

- `@plumbus/chat` with Path B provider-native tool calling and the `POST /chat/:name/confirm` route (see its changelog). Peer range unchanged.
- **A `@plumbus/chat` that ships the `./protocol` export subpath.** `useChat` imports `CHAT_CSRF_COOKIE_NAME` / `CHAT_CSRF_HEADER_NAME` from `@plumbus/chat/protocol` rather than the package root, so the browser bundle does not pull in `node:crypto` and the `@plumbus/core` CLI — a graph strict bundlers such as Turbopack refuse to resolve for a client component. Against an older `@plumbus/chat` without that subpath, module resolution fails at build time.

## 0.1.6

### Changed

- Peer dependency `@plumbus/core` corrected to `0.5.x || 0.6.x` so npm accepts `@plumbus/core` **0.6.x** (`^0.5.0 <0.7.0` only matched 0.5.x under npm semver).

## 0.1.5

### Changed

- Peer dependency `@plumbus/core` widened to `^0.5.0 <0.7.0` for `@plumbus/core` **0.6.x** compatibility.

## 0.1.4

### Changed

- Peer dependency `@plumbus/core` updated to `^0.5.0 <0.6.0` for the **0.5.0** release.

## 0.1.3

### Documentation

- README ecosystem table lists `@plumbus/api` (partner external API add-on).

## 0.1.2 — 2026-05-25

- `buildTurnRequestBody` now propagates each message's `refusalReason` into the `clientHistory` wire payload. Required for `@plumbus/chat@0.1.2`'s `saveToDb: false` mode — server-side behavioral cooldown enforcement uses the per-message refusal flags from the wire when there's no DB state.
- Exported `WireHistoryMessage` + `WireRefusalReason` types alongside existing helper types.

## 0.1.1 — 2026-05-19

- Auto-detect JSON vs SSE responses in `useChat` (`credentials: 'include'` for cookie auth).
- `send(text, extras?)` supports per-call `sessionId`, `locale`, and `extraBody` overrides.
- `turn.completed` applies `inScope` / `refusalReason` to the last assistant message.
- Exported `applyChatEvent`, `buildTurnRequestBody`, and related helper types from the package barrel.

## 0.1.0 — 2026-05-19

Initial release. Thin React layer over `@plumbus/chat`'s event stream.

### Added

- `useChat({ chatName, sessionId, audience, locale, persistence?, turnUrl? })`
  hook that subscribes to the chat SSE event stream and reduces it into local
  state (messages, status, notices, pendingConfirmation). In `client`
  persistence mode `send()` sends the last 20 local messages as
  `clientHistory` on the wire (Task 7.4b).
- `applyChatEvent` and `buildTurnRequestBody` exported as pure helpers so the
  state-transition logic is independently testable.
- `readChatStream(response)` async-iterator that parses `data: …\n\n` SSE
  frames into typed `ChatEvent`s.
- `<ChatPanel>`, `<ChatMessages>`, `<ChatInput>`, `<ConfirmationDialog>`,
  `<SourceCitation>` components — minimal Tailwind-passthrough, no design
  system.
