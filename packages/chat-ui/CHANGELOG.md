# Changelog

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
