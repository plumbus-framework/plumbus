# Changelog

## 0.1.1

### Fixed

- Attach `SONIOX_VOICE_PRICING` on `SONIOX_STT_REGISTRATION.pricing` and populate `SONIOX_STT_MODELS` with `costModelKey: 'soniox-stt'` so `createProviderRegistry()` seeds ledger USD (no more `$0` rows with real audio seconds).

## 0.1.0

### Added

- Initial extraction of the Soniox STT provider from `@plumbus/voice` 0.3.0.
- Export: `SONIOX_STT_REGISTRATION` (register via `*_REGISTRATION` passed to `createProviderRegistry()`).
- Required env / credentials: `SONIOX_API_KEY` (`apiKey`).
