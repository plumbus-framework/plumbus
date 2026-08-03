# Changelog

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
