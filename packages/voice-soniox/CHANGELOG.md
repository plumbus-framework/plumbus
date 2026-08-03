# Changelog

## 0.1.2

### Added

- Persisted voice cloning on `SONIOX_TTS_REGISTRATION.clone` (`client.tts.voices.*`, `waitUntilReady` / `recompute`).

### Changed

- Dependency `@soniox/node` bumped to `^2.2.0` (required for `tts.voices`).

## 0.1.1

### Added

- `SONIOX_TTS_REGISTRATION` for `tts.provider: 'soniox'` via `@soniox/node` `client.tts.generateStream()` (default `pcm_s16le` @ 16 kHz).
- `SONIOX_TTS_DESCRIPTOR` / `SONIOX_TTS_MODELS` / `SONIOX_TTS_VOICES` catalog surfaces.
- TTS pricing row `soniox-tts` on `SONIOX_VOICE_PRICING` (STT row unchanged under `soniox-stt`). Approximate character estimate of Soniox’s token billing (~$0.70/hr speech), not exact tokens.
- Gated live smoke (`VOICE_LIVE_TEST=1`) for Soniox TTS.

### Fixed

- Attach `SONIOX_VOICE_PRICING` on `SONIOX_STT_REGISTRATION.pricing` and populate `SONIOX_STT_MODELS` with `costModelKey: 'soniox-stt'` so `createProviderRegistry()` seeds ledger USD (no more `$0` rows with real audio seconds).
- Forward `AbortSignal` from `synthesizeStream` into SDK `generateStream({ signal })` for barge-in cancellation.

### Changed

- `SONIOX_VOICE_PRICING` is now a `Record` of STT + TTS rows (was a single STT entry). STT registration reads `SONIOX_VOICE_PRICING['soniox-stt']`.

## 0.1.0

### Added

- Initial extraction of the Soniox STT provider from `@plumbus/voice` 0.3.0.
- Export: `SONIOX_STT_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `SONIOX_API_KEY` (`apiKey`).
