# Changelog

## 0.1.3

### Added

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
