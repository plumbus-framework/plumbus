# Changelog

## 0.1.3

### Added

- **The disconnect error is now catchable at all.** `generateToBuffer` → `generateTo` are plain (non-async) functions in `@deepdub/node`, and the socket readyState check throws *synchronously*. `#startGeneration(...).catch(reconnect)` therefore never attached its handler — the throw escaped `synthesizeStream` and no reconnect ever ran, in this version or the previous single-retry one. `#startGeneration` is now `async`, which turns that throw into a rejection the retry path can see. Guarded by a wire test whose fake throws synchronously, as the SDK does; every earlier fake used `async generateToBuffer`, which returns a rejection, so the retry looked healthy while production died.
- **Idle sockets are replaced, not trusted.** `wss://wsapi.deepdub.ai/open` is closed by the far end after an idle gap and the SDK has no keepalive for it (`asyncStreamPing` exists only for the separate `wss://wss.deepdub.ai/ws` streaming endpoint, and API Gateway ignores websocket ping frames regardless). A socket unused for longer than 120 s is now discarded and reopened before synthesis, so a conversational pause costs a handshake instead of a failed turn. Overridable for tests via the credentials option `idleReconnectMs`.
- **Websocket reconnect with backoff** — a dropped or refused Deepdub websocket is now retried up to 3 times, 1 s apart, for both the initial connect and a mid-turn drop (previously: one immediate retry after a drop, none for a refused connect). Deepdub closes an idle socket, so a long conversational pause left the next reply failing with `WebSocket is not connected. Call connect() first.` and the voice session effectively dead. Retries stop early when the turn is aborted, and are skipped once any audio has been published (re-synthesizing would replay the opening of the reply). Spacing is overridable for tests via the provider credentials option `reconnectDelayMs`.

### Fixed

- **`mapDeliveryTone` no longer drops a tone-supplied `voiceId`** — a per-turn `DeliveryTone.voiceId` (e.g. an emotional style variant `voicePromptId` of the same speaker family, chosen by a tone classifier) now overrides the static `tts.voiceId` on every synthesis call, enabling per-register style switching. Requires `@plumbus/voice` ≥ 0.4.4 for the `DeliveryTone.voiceId` field. Falls back to the static voice when absent.

## 0.1.2

### Added

- Persisted voice cloning on `DEEPDUB_TTS_REGISTRATION.clone` (`addVoice` create, REST get/delete, SDK `listVoices`).
- Instant-reference preview via `synthesizeWithVoiceReference` / HTTP `generateToBuffer` + `voiceReference`.
- Session TTS with `tts.options.voiceReference` wraps the HTTP buffer as a single-chunk async iterable (non-streaming preview).

### Changed

- Dependency `@deepdub/node` bumped to `^3.0.2`.

## 0.1.1

### Fixed

- Attach `DEEPDUB_VOICE_PRICING` on `DEEPDUB_TTS_REGISTRATION.pricing` so `createProviderRegistry()` seeds ledger USD for `deepdub-phantom-x`.

## 0.1.0

### Added

- Initial extraction of the Deepdub TTS provider from `@plumbus/voice` 0.3.0.
- Export: `DEEPDUB_TTS_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `DEEPDUB_API_KEY` (`apiKey`); optional `DEEPDUB_VOICE_ID` for harnesses and smoke tests.
