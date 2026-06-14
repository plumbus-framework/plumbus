# Changelog

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
